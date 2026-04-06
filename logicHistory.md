# Carlton CRM — Backend Logic History

This file documents every key business logic implementation in the backend. Read this before implementing any algorithm to avoid reimplementing existing logic.

---

## 1. Round-Robin Auto-Assignment

**What it does**: Distributes unassigned leads evenly across active team members using a round-robin algorithm.

**File**: `src/services/teamService.ts`
**Function/Method**: `autoAssignTeamLeads(teamId, userId)`

### Algorithm (Step-by-Step)

1. Fetch the team with populated `members`, `leaders`, and `inactiveMembers`:
   ```typescript
   const team = await Team.findById(teamId)
     .populate("members", "_id name email")
     .populate("leaders", "_id")
     .populate("inactiveMembers", "_id");
   ```

2. Get all unassigned leads for this team:
   ```typescript
   const unassignedLeads = await Lead.find({
     team: teamId,
     assignedTo: null,
     status: "new"
   }).lean();
   ```

3. Build the active member list — exclude leaders AND inactive members:
   ```typescript
   const leaderIds = new Set(team.leaders.map(l => l._id.toString()));
   const inactiveIds = new Set(team.inactiveMembers.map(m => m._id.toString()));
   // CRITICAL: use ._id.toString() — not .toString() on populated doc
   const activeMembers = team.members.filter(m =>
     !leaderIds.has(m._id.toString()) && !inactiveIds.has(m._id.toString())
   );
   ```

4. If no active members → return `{ assigned: 0, assignments: [] }`

5. For each active member, count their current assigned leads to sort from lowest to highest:
   ```typescript
   const memberLeadCounts = await Promise.all(
     activeMembers.map(async m => ({
       member: m,
       count: await Lead.countDocuments({ team: teamId, assignedTo: m._id })
     }))
   );
   memberLeadCounts.sort((a, b) => a.count - b.count);
   ```

6. Distribute leads round-robin (pointer cycles through sorted member list):
   ```typescript
   const assignments = [];
   let pointer = 0;
   for (const lead of unassignedLeads) {
     const member = memberLeadCounts[pointer % memberLeadCounts.length].member;
     await Lead.findByIdAndUpdate(lead._id, {
       $set: { assignedTo: member._id, status: "assigned" }
     });
     emitToUser(member._id.toString(), "lead:assigned", {
       leadId: lead._id,
       leadName: lead.name,
       assignedBy: userId
     });
     assignments.push({ leadId: lead._id, assignedTo: member._id });
     pointer++;
   }
   ```

7. Return `{ assigned: unassignedLeads.length, assignments }`

### Edge Cases Handled
- No active members → returns 0 assigned, empty array
- All members are leaders or inactive → returns 0
- No unassigned leads → returns 0 immediately
- Members with equal lead count — order is stable (sorted ascending, first one wins ties)

### Related Logic
- `toggleMemberActive` (Logic #6) — manages the inactiveMembers list this algorithm reads
- `leadService.autoAssignLeads` — global version (not team-scoped), uses same pattern

---

## 2. JWT Auth Flow

**What it does**: Login, token generation, refresh, and role-aware authentication.

**File**: `src/services/authService.ts`, `src/middleware/auth.ts`, `src/utils/jwt.ts`
**Functions**: `login`, `refreshToken`, and the `authenticate` middleware

### Login Flow
```
POST /auth/login
  → authController.login
  → authService.login(email, password)
     1. User.findOne({ email }).select("+password").populate("role")
     2. bcrypt.compare(password, user.password)  — throws 401 if mismatch
     3. generateAccessToken({ userId, email, roleId })  — 15min TTL
     4. generateRefreshToken({ userId })  — 7d TTL
     5. return { user, accessToken, refreshToken }
```

### Access Token Payload
```typescript
{
  userId: string,
  email: string,
  roleId: string
}
```

### Refresh Token Payload
```typescript
{
  userId: string
}
```

### Token Refresh Flow
```
POST /auth/refresh  (body: { refreshToken })
  → authController.refreshToken
  → authService.refreshToken(token)
     1. verifyRefreshToken(token)  — throws 401 if invalid/expired
     2. User.findById(decoded.userId)  — throws 401 if not found
     3. generateAccessToken({ userId, email, roleId })
     4. return { accessToken }
```

### Auth Middleware (authenticate)
On every protected request:
1. Extract `Bearer <token>` from `Authorization` header
2. `verifyAccessToken(token)` — throws 401 if invalid/expired
3. `User.findById(decoded.userId).select("-password")` — throws 401 if not found
4. Check `user.status !== "inactive"` — throws 403 if inactive
5. `Role.findById(user.role)` — loads FRESH role from DB (not from token payload)
6. Attaches `req.user = { userId, email, roleId, role: fullRoleDocument }`

### Why Role is Loaded Fresh Every Request
The role's permissions could change after the token was issued. If we relied solely on the JWT payload for permissions, a role change would not take effect until token expiry. Loading fresh from DB ensures permissions are always current.

### Edge Cases
- Token missing → 401 "No token provided"
- Token expired → 401 "Token expired"
- User deleted after token issued → 401 "User not found"
- User deactivated after token issued → 403 "Account deactivated"
- Role deleted after token issued → 403 (role lookup fails)

---

## 3. Permission Check Logic

**What it does**: Guards routes by checking user's role permissions.

**File**: `src/middleware/permissions.ts`
**Functions**: `checkPermission(module, action)`, `requireModule(module)`

### checkPermission(module, action)
```typescript
export const checkPermission = (module: CrmModule, action: PermissionAction) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const { role } = req.user;

    // Super Admin bypass — always passes
    if (role.isSystemRole && role.roleName === "Super Admin") {
      return next();
    }

    const perms = role.permissions?.[module];
    if (!perms || !perms[action]) {
      return sendError(res, "Permission denied", 403);
    }
    next();
  };
};
```

### requireModule(module)
```typescript
export const requireModule = (module: CrmModule) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const { role } = req.user;

    if (role.isSystemRole && role.roleName === "Super Admin") return next();

    const perms = role.permissions?.[module];
    if (!perms) return sendError(res, "Permission denied", 403);

    const hasAny = Object.values(perms).some(v => v === true);
    if (!hasAny) return sendError(res, "Permission denied", 403);
    next();
  };
};
```

### Edge Cases
- `role.permissions` is undefined/null → treated as no permissions (403)
- `role.permissions[module]` is undefined → 403
- Super Admin with `isSystemRole: false` → does NOT bypass (intentional)
- Only the exact combination of `isSystemRole: true` + `roleName: "Super Admin"` bypasses

---

## 4. Lead CSV/Excel Upload

**What it does**: Parses a spreadsheet file, validates rows, bulk-inserts valid leads.

**Files**: `src/services/excelService.ts` (parsing), `src/services/leadService.ts` (bulkCreateLeads)
**Function**: `leadService.bulkCreateLeads(buffer, reporterId, teamId?)`

### Algorithm (Step-by-Step)

1. Controller receives file via multer (memory storage) — `req.file.buffer`
2. Calls `excelService.parseExcelBuffer(buffer, reporterId)` → `{ valid, invalid }`

3. Email validation (critical — see mistakes.md #2):
   ```typescript
   const emailRegex = /^\S+@\S+\.\S+$/;
   const email = emailRegex.test(row.email) ? row.email : undefined;
   // "No Email", "", "N/A" all fail regex → stored as undefined
   ```

4. Notes must be an array (critical — see mistakes.md #2):
   ```typescript
   // WRONG: notes: row.notes
   // CORRECT:
   const notes = row.notes
     ? [{ content: row.notes, author: reporterId }]
     : [];
   ```

5. Map valid rows to Lead documents:
   ```typescript
   const docs = valid.map(row => ({
     name: row.name,
     phone: row.phone,
     email: email,  // undefined if invalid
     source: row.source || "manual",
     status: "new",
     createdBy: reporterId,
     team: teamId || undefined,
     notes: notes,
     activityLogs: [{ action: "lead_created", ... }]
   }));
   ```

6. Insert with `ordered: false` (partial success allowed):
   ```typescript
   const result = await Lead.insertMany(docs, { ordered: false });
   const failed = docs.length - result.length;
   ```

7. Return `{ created: result.length, failed, errors: invalidRows }`

### Edge Cases Handled
- "No Email" string → stored as `undefined`
- Invalid email format → stored as `undefined`
- Missing name or phone → row goes to `invalid` in excelService
- Duplicate phone within file → second row goes to `invalid`
- Duplicate phone already in DB → `insertMany` silently skips (ordered: false), counted as failed
- Empty file → returns `{ created: 0, failed: 0, errors: [] }`

### Related Logic
- excelService.parseExcelBuffer — handles the raw parsing and per-row validation

---

## 5. Reminder Scheduler Two-Pass

**What it does**: Fires real-time and push notifications for due reminders and upcoming reminders.

**File**: `src/services/reminderScheduler.ts`
**Function**: `tick()` — called every 30 seconds

### Scheduler Initialization
```typescript
export function startReminderScheduler() {
  tick(); // run immediately on start
  setInterval(tick, 30_000); // then every 30 seconds
}
```

### Pass 1 — On-Time Notifications (reminder is due now or overdue)

**MongoDB Query**:
```typescript
const now = new Date();
const leads = await Lead.find({
  "reminders": {
    $elemMatch: {
      remindAt: { $lte: now },
      isDone: false,
      notifiedAt: null
    }
  }
});
```

**For each matching lead**, iterate reminders and fire for those matching Pass 1 criteria:
```typescript
for (const lead of leads) {
  for (const reminder of lead.reminders) {
    if (reminder.remindAt <= now && !reminder.isDone && !reminder.notifiedAt) {
      // Emit socket event
      emitToUser(reminder.assignedTo.toString(), "reminder:due", {
        reminderId: reminder._id,
        leadId: lead._id,
        leadName: lead.name,
        title: reminder.title,
        body: reminder.body,
        remindAt: reminder.remindAt
      });

      // Send push notification
      await sendPushToUser(reminder.assignedTo.toString(), {
        title: reminder.title,
        body: `Due: ${reminder.body}`,
        tag: `reminder-${reminder._id}`,
        url: `/leads/${lead._id}`
      });

      // Stamp notifiedAt — use arrayFilters to target exact reminder
      await Lead.updateOne(
        { _id: lead._id },
        { $set: { "reminders.$[r].notifiedAt": now } },
        { arrayFilters: [{ "r._id": reminder._id }] }
      );
    }
  }
}
```

### Pass 2 — Warning Notifications (reminder coming up in 1-31 minutes)

**MongoDB Query**:
```typescript
const nowPlus1 = new Date(now.getTime() + 1 * 60 * 1000);
const nowPlus31 = new Date(now.getTime() + 31 * 60 * 1000);
const warningLeads = await Lead.find({
  "reminders": {
    $elemMatch: {
      remindAt: { $gte: nowPlus1, $lte: nowPlus31 },
      isDone: false,
      warnedAt: null
    }
  }
});
```

**For each matching reminder**:
```typescript
const minsLeft = Math.round((reminder.remindAt.getTime() - now.getTime()) / 60000);
emitToUser(reminder.assignedTo.toString(), "reminder:warning", {
  reminderId: reminder._id,
  leadId: lead._id,
  leadName: lead.name,
  title: reminder.title,
  body: reminder.body,
  minsLeft,
  remindAt: reminder.remindAt
});

// Stamp warnedAt
await Lead.updateOne(
  { _id: lead._id },
  { $set: { "reminders.$[r].warnedAt": now } },
  { arrayFilters: [{ "r._id": reminder._id }] }
);
```

### Edge Cases Handled
- Reminder marked `isDone: true` before scheduler runs → skipped (isDone check)
- Reminder already notified (`notifiedAt` not null) → skipped (idempotent)
- Reminder already warned (`warnedAt` not null) → skipped (idempotent)
- Multiple reminders on same lead — `arrayFilters` with `"r._id"` ensures only the correct sub-document is updated
- Scheduler fires while previous tick is still running → each tick is independent, no lock needed (low probability of overlap at 30s interval)

### Related Logic
- `addReminder` in leadService — creates the reminder sub-document this scheduler reads
- `reminder:due` and `reminder:warning` socket events — see socketHistory.md

---

## 6. Team Member Active/Inactive Toggle

**What it does**: Activates or deactivates a team member, controlling their eligibility for auto-assignment.

**File**: `src/services/teamService.ts`
**Function/Method**: `toggleMemberActive(teamId, memberId)`

### Algorithm
```typescript
async toggleMemberActive(teamId: string, memberId: string) {
  const team = await Team.findById(teamId).populate("inactiveMembers", "_id");

  if (!team) throw createError("Team not found", 404);

  // Check current state — MUST use ._id.toString() on populated docs
  const isCurrentlyInactive = team.inactiveMembers.some(
    m => m._id.toString() === memberId
  );

  let updateOp;
  if (isCurrentlyInactive) {
    // Activate: remove from inactiveMembers
    updateOp = { $pull: { inactiveMembers: memberId } };
  } else {
    // Deactivate: add to inactiveMembers
    updateOp = { $addToSet: { inactiveMembers: memberId } };
  }

  const updated = await Team.findByIdAndUpdate(teamId, updateOp, { new: true })
    .populate("members inactiveMembers leaders");

  return updated;
}
```

### Key Details
- Uses `$addToSet` not `$push` — prevents duplicates if called twice
- Does NOT emit a socket event — UI polls via React Query invalidation
- Does NOT reassign leads from deactivated member — their existing leads remain
- Effect is immediate — next `autoAssignTeamLeads` call will exclude inactive members

### Edge Cases
- memberId not in `team.members` — toggle still runs (inactiveMembers can technically include non-members, but service should validate membership first)
- Called twice rapidly → `$addToSet` is idempotent for deactivate; `$pull` is idempotent for activate

---

## 7. selfOrPermission

**What it does**: Allows users to view their own profile without needing the `users:view` permission, while still protecting other users' profiles.

**File**: `src/routes/userRoutes.ts` (inline middleware, not a standalone file)
**Used on**: `GET /api/v1/users/:id`

### Implementation
```typescript
const selfOrPermission = (req: Request, res: Response, next: NextFunction) => {
  // If the requesting user is viewing their own record → allow
  if (req.user.userId === req.params.id) {
    return next();
  }
  // Otherwise → require users:view permission
  checkPermission("users", "view")(req, res, next);
};

router.get("/:id", authenticate, selfOrPermission, getUserById);
```

### Why This Exists
Users need to load their own profile (for the header/navbar, settings page, etc.) without requiring admins to grant `users:view` to every role. Sales agents should be able to see their own name/email/role without being able to browse all users.

### Edge Cases
- User A trying to view User B's profile → falls through to `checkPermission("users", "view")`
- Super Admin viewing any profile → passes checkPermission (Super Admin bypass)
- User viewing own profile → skips permission check entirely

---

## 8. Activity Log Tracking

**What it does**: Records every mutation to a lead in the `activityLogs` embedded array.

**File**: `src/services/leadService.ts`
**Pattern**: Every mutation method pushes a log entry

### ActivityLog Schema
```typescript
{
  action: ActivityAction,       // enum string
  description: string,          // human-readable description
  performedBy: ObjectId,        // userId who made the change
  createdAt: Date,              // auto-set
  changes?: {                   // optional field-level diff
    [field: string]: {
      from: unknown,
      to: unknown
    }
  }
}
```

### Activity Actions (enum)
- `lead_created` — new lead creation
- `lead_updated` — general field update
- `status_changed` — `lead.status` changed
- `lead_assigned` — `assignedTo` changed
- `team_assigned` — `lead.team` changed
- `note_added` — note pushed to `lead.notes`
- `note_updated` — note content changed
- `note_deleted` — note removed
- `reminder_added` — reminder created
- `reminder_updated` — reminder updated
- `reminder_done` — reminder marked done
- `payment_added` — payment recorded

### Example — Status Change Log Entry
```typescript
lead.activityLogs.push({
  action: "status_changed",
  description: `Status changed from ${oldStatus} to ${newStatus}`,
  performedBy: userId,
  changes: {
    status: { from: oldStatus, to: newStatus }
  },
  createdAt: new Date()
});
```

### Performance Note
`activityLogs` grows unboundedly. For very active leads, use `$slice` on reads or consider a separate collection if the array exceeds ~100 entries.

---

## 9. Google Sheets Sync

**What it does**: Receives lead data from Google Sheets (via Apps Script) and upserts it into the CRM.

**File**: `src/controllers/sheetsController.ts` (+ optional `src/services/sheetsService.ts`)
**Routes**: `POST /api/sheets/sync` (single), `POST /api/sheets/sync/batch` (array)
**Auth**: `authenticateApiKey` middleware (NOT JWT) — reads `x-api-key` header

### Single Row Sync
```
POST /api/sheets/sync
Headers: { "x-api-key": SHEETS_API_KEY }
Body: { name, phone, email, source, course, ... }
```
1. Validate required fields (name, phone)
2. `Lead.findOneAndUpdate({ phone }, { $set: mappedFields }, { upsert: true, new: true })`
3. Returns `{ created: boolean, lead }`

### Batch Sync
```
POST /api/sheets/sync/batch
Body: { rows: [...] }
```
1. Validate each row
2. `Promise.all(rows.map(row => Lead.findOneAndUpdate({ phone }, ...)))`
3. Returns `{ synced: count, errors: [...] }`

### Column Mapping
Google Sheets columns map to Lead fields:
- Column A → `name`
- Column B → `phone`
- Column C → `email` (validated, undefined if invalid)
- Column D → `source`
- Column E → `course` name (looked up in Course collection)
- Column F → `notes` (wrapped as array)

### Edge Cases
- SHEETS_API_KEY not set in env → `authenticateApiKey` returns 503
- Missing x-api-key header → 401
- Wrong key → 401
- Duplicate phone → upserts (updates existing lead, does not create duplicate)

---

## 10. AI Chat Context

**What it does**: Provides Claude AI assistance within different CRM contexts (lead, team, report).

**File**: `src/controllers/aiController.ts`
**Routes**: `POST /ai/chat/lead/:leadId`, `POST /ai/chat/team/:teamId`, `POST /ai/chat/report`
**Memory Model**: `AiMemory` — stores conversation per `{ contextType, contextId, userId }`

### Context Types
1. **Lead context** (`POST /ai/chat/lead/:leadId`):
   - Fetches full lead data (notes, status, payments, reminders, activityLogs)
   - Builds system prompt with lead details as context
   - Sends conversation history + new user message to Anthropic Claude API
   - Stores updated conversation in AiMemory

2. **Team context** (`POST /ai/chat/team/:teamId`):
   - Fetches team stats, member performance, recent activity
   - Builds system prompt with team analytics
   - Same conversation flow

3. **Report context** (`POST /ai/chat/report`):
   - No `contextId` — single memory per userId for report context
   - Fetches overall CRM statistics for context
   - Useful for "what is our conversion rate?" type questions

### Memory Structure
```typescript
{
  contextType: "lead" | "team" | "report",
  contextId: string | null,  // null for report context
  userId: string,
  messages: [
    { role: "user" | "assistant", content: string, timestamp: Date }
  ]
}
```

### Conversation Flow
1. Fetch `AiMemory.findOne({ contextType, contextId, userId })`
2. If none exists → create new empty memory
3. Append new user message to `memory.messages`
4. Build messages array for Anthropic API (last N messages for context window)
5. Call `anthropic.messages.create({ model, system, messages })`
6. Append assistant response to `memory.messages`
7. Save updated memory
8. Return `{ reply: assistantMessage, memoryId }`

### Memory Management Routes
- `GET /api/v1/ai/memory/:leadId` — fetch conversation history for a lead
- `DELETE /api/v1/ai/memory/:leadId` — clear conversation for a lead
