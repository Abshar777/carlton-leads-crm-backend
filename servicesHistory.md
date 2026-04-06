# Carlton CRM — Backend Services History

This file documents every service in `backend/src/services/`. Read this before writing any new service method to avoid duplication.

---

## 1. authService.ts

**File**: `src/services/authService.ts`
**Purpose**: Handles all authentication and authorization logic — login, token refresh, profile retrieval, password change.
**Model(s) used**: `User`, `Role`
**Utils called**: `generateAccessToken`, `generateRefreshToken`, `verifyRefreshToken` from `utils/jwt.ts`; `sendSuccess`, `sendError` (used in controller, not service)
**Called by**: `authController.ts`
**Routes that trigger it**: `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `GET /api/v1/auth/profile`, `PUT /api/v1/auth/change-password`

### Methods

#### `login(email: string, password: string)`
- Finds user by email using `User.findOne({ email }).select("+password").populate("role")`
- If user not found → throws 401 "Invalid credentials"
- If user status is "inactive" → throws 403 "Account deactivated"
- Calls `bcrypt.compare(password, user.password)` — throws 401 if mismatch
- Generates `accessToken` (15min TTL) and `refreshToken` (7d TTL) using jwt utils
- Returns `{ user: { _id, name, email, role }, accessToken, refreshToken }`
- Password is never returned — stripped before returning

#### `refreshToken(token: string)`
- Calls `verifyRefreshToken(token)` — throws 401 if invalid/expired
- Extracts `userId` from decoded payload
- Fetches user from DB — throws 401 if not found
- Generates a new `accessToken` (15min TTL)
- Returns `{ accessToken }`

#### `getProfile(userId: string)`
- Fetches user by `_id` using `.findById(userId).populate("role").select("-password").lean()`
- Throws 404 if not found
- Returns full user profile object

#### `changePassword(userId: string, currentPassword: string, newPassword: string)`
- Fetches user with `User.findById(userId).select("+password")`
- Calls `bcrypt.compare(currentPassword, user.password)` — throws 400 if wrong
- Hashes `newPassword` with `bcrypt.hash(newPassword, 10)`
- Updates `user.password = hashed`, calls `user.save()`
- Returns success message

---

## 2. leadService.ts

**File**: `src/services/leadService.ts`
**Purpose**: All lead domain business logic — CRUD, status management, assignment, notes, reminders, payments, bulk operations.
**Model(s) used**: `Lead`, `Team`, `User`, `Course`
**Utils called**: `emitToUser` from `socket.ts`, `sendPushToUser` / `notifyLeadAssignment` / `notifyBulkLeadAssignment` from `pushService.ts`, `buildPagination` from `utils/response.ts`
**Called by**: `leadController.ts`
**Routes that trigger it**: All routes under `/api/v1/leads/*`

### Methods

#### `createLead(data, reporterId)`
- Validates required fields (name, phone, course, source)
- Creates new Lead document with `status: "new"`, `createdBy: reporterId`
- Pushes `lead_created` entry to `activityLogs`
- Returns saved lead

#### `getLeads(filters, pagination, userId, role)`
- Builds dynamic query based on filters (status, assignedTo, team, search, dateRange, course, source)
- If user role lacks `leads:view` or is scoped, filters to `assignedTo: userId`
- Uses `.lean()` with `.populate("assignedTo", "name email").populate("team", "name").populate("course", "name")`
- Returns `{ leads, pagination: buildPagination(total, page, limit) }`

#### `getLead(leadId)`
- `Lead.findById(leadId).populate("assignedTo", "name email").populate("team", "name").populate("course", "name").populate("createdBy", "name email")`
- Throws 404 if not found
- Returns full lead with populated fields

#### `updateLead(leadId, data, userId)`
- Finds lead by ID (not lean — needs save)
- Tracks changed fields for `activityLogs`
- Updates allowed fields (name, phone, email, source, course, address, etc.)
- Pushes `lead_updated` entry to `activityLogs` with `changes: { field: { from, to } }`
- Calls `lead.save()`

#### `updateLeadStatus(leadId, status, userId)`
- Finds lead, changes `lead.status`
- Pushes `status_changed` to `activityLogs`
- Saves lead
- Returns updated lead

#### `assignLead(leadId, assignedTo, assignedBy)`
- Finds lead, sets `lead.assignedTo = assignedTo`, `lead.status = "assigned"`
- Pushes `lead_assigned` to `activityLogs`
- Calls `emitToUser(assignedTo, "lead:assigned", { leadId, leadName, assignedBy })`
- Calls `notifyLeadAssignment(assignedTo, leadId, lead.name, assignedBy)`
- Saves and returns lead

#### `assignLeadToTeam(leadId, teamId, userId)`
- Sets `lead.team = teamId`, `lead.status = "assigned"`
- Pushes `team_assigned` to `activityLogs`
- Saves lead
- Returns updated lead

#### `transferLeadToTeam(leadId, newTeamId, userId)`
- Unsets old team assignment, sets new `lead.team = newTeamId`
- Pushes `team_assigned` to `activityLogs`
- Returns updated lead

#### `deleteLead(leadId)`
- `Lead.findByIdAndDelete(leadId)` — hard delete
- Throws 404 if not found
- Returns deleted lead id

#### `bulkCreateLeads(rows, reporterId)`
- Calls `excelService.parseExcelBuffer()` (from controller which passes buffer)
- Maps valid rows to Lead documents — sets `notes` as array, validates email with regex
- `Lead.insertMany(docs, { ordered: false })`
- Counts `result.length` vs `docs.length` for failed count
- Returns `{ created: result.length, failed: docs.length - result.length, errors: [...] }`

#### `autoAssignLeads(teamId, userId)`
- Gets unassigned leads for the team (`assignedTo: null, team: teamId`)
- Fetches active members (see logicHistory.md for round-robin algorithm)
- Distributes leads one by one, calls `emitToUser` per assignment
- Returns `{ assigned: number, assignments: [{leadId, assignedTo}] }`

#### `addNote(leadId, content, authorId)`
- Finds lead (not lean)
- Pushes `{ content, author: authorId, createdAt: new Date() }` to `lead.notes`
- Pushes `note_added` to `activityLogs`
- Saves lead

#### `updateNote(leadId, noteId, content, userId)`
- Uses `$set` with `arrayFilters: [{ "n._id": noteId }]` to update specific note
- Pushes `note_updated` to `activityLogs`

#### `deleteNote(leadId, noteId, userId)`
- Uses `$pull` to remove note by `_id`
- Pushes `note_deleted` to `activityLogs`

#### `bulkUpdateStatus(leadIds, status, userId)`
- `Lead.updateMany({ _id: { $in: leadIds } }, { $set: { status } })`
- Returns `{ updated: result.modifiedCount }`

#### `bulkDelete(leadIds)`
- `Lead.deleteMany({ _id: { $in: leadIds } })`
- Returns `{ deleted: result.deletedCount }`

#### `bulkAssignToTeam(leadIds, teamId, userId)`
- `Lead.updateMany({ _id: { $in: leadIds } }, { $set: { team: teamId, status: "assigned" } })`
- Returns `{ updated: result.modifiedCount }`

#### `getMyReminders(userId, filters)`
- Finds leads where `reminders` array contains items with `assignedTo: userId` and `isDone: false`
- Uses `$elemMatch` to filter embedded reminders
- Returns flattened array of reminders with lead info

#### `getMyReminderCount(userId)`
- Counts upcoming active reminders for the user
- Returns `{ count: number }`

#### `addReminder(leadId, data, userId)`
- Pushes reminder object to `lead.reminders`: `{ title, body, remindAt, assignedTo: userId, isDone: false, notifiedAt: null, warnedAt: null }`
- Saves lead
- Returns added reminder

#### `updateReminder(leadId, reminderId, data, userId)`
- `$set` with `arrayFilters: [{ "r._id": reminderId }]`
- Returns updated lead

#### `deleteReminder(leadId, reminderId, userId)`
- `$pull { reminders: { _id: reminderId } }`
- Returns updated lead

#### `addPayment(leadId, data, userId)`
- Pushes payment object to `lead.payments`: `{ amount, mode, date, note, recordedBy: userId }`
- Saves lead
- Returns updated lead

#### `updatePayment(leadId, paymentId, data, userId)`
- `$set` with `arrayFilters: [{ "p._id": paymentId }]`

#### `deletePayment(leadId, paymentId, userId)`
- `$pull { payments: { _id: paymentId } }`

---

## 3. teamService.ts

**File**: `src/services/teamService.ts`
**Purpose**: All team domain business logic — CRUD, member management, auto-assignment, revenue analytics, team chat.
**Model(s) used**: `Team`, `Lead`, `User`, `TeamMessage`
**Utils called**: `emitToUser` from `socket.ts`, `emitTeamUpdate` from `socket.ts`, `notifyLeadAssignment` from `pushService.ts`, `buildPagination` from `utils/response.ts`
**Called by**: `teamController.ts`
**Routes that trigger it**: All routes under `/api/v1/teams/*`

### Methods

#### `createTeam(data)`
- Creates Team document with `{ name, description, leaders, members }`
- Returns saved team

#### `getTeamByMember(userId)`
- Finds team where `members` array includes `userId`
- Populates members and leaders
- Returns team or null

#### `getTeams(filters, pagination)`
- Lists all teams with pagination
- Populates `members` (name, email) and `leaders` (name, email)
- Returns `{ teams, pagination }`

#### `getTeamById(teamId)`
- Finds team by ID, populates members/leaders
- Throws 404 if not found

#### `updateTeam(teamId, data)`
- Updates team name, description, leaders, members
- Throws 404 if not found

#### `deleteTeam(teamId)`
- Hard deletes team
- Does NOT reassign leads — caller responsible for cleanup

#### `getTeamLeads(teamId, filters, pagination)`
- Finds leads by `team: teamId` with filter support (status, assignedTo, search)
- Returns paginated lead list

#### `getTeamMemberStats(teamId)`
- Aggregation pipeline: groups leads by `assignedTo` within team
- Returns `[{ userId, name, email, totalLeads, byStatus: { ... } }]`

#### `autoAssignTeamLeads(teamId, userId)`
- See `logicHistory.md` — Round-Robin Auto-Assignment
- Gets unassigned team leads, builds active member list, distributes round-robin
- Returns `{ assigned, assignments }`

#### `assignLeadToMember(teamId, leadId, memberId, assignedBy)`
- Verifies memberId is in team.members
- Calls `leadService.assignLead(leadId, memberId, assignedBy)`

#### `getTeamDashboard(teamId)`
- Aggregates lead stats, revenue, member performance for the team
- Returns dashboard summary object

#### `getTeamLogs(teamId, pagination)`
- Fetches `activityLogs` from all leads in the team
- Returns sorted, paginated log entries

#### `toggleMemberActive(teamId, memberId)`
- Checks if memberId is in `team.inactiveMembers`
- If inactive → `$pull` from inactiveMembers (activate)
- If active → `$push` to inactiveMembers (deactivate)
- See `logicHistory.md` for detail
- Returns updated team

#### `getTeamMemberById(teamId, memberId)`
- Verifies memberId is a member of teamId
- Returns user profile with team context

#### `getTeamMemberLeads(teamId, memberId, filters, pagination)`
- Finds leads where `team: teamId` AND `assignedTo: memberId`
- Returns paginated leads

#### `getTeamUpdates(teamId, pagination)`
- Fetches team activity feed (recent log entries across all leads in team)
- Returns paginated update items

#### `postTeamMessage(teamId, senderId, content)`
- Creates `TeamMessage` document: `{ teamId, sender: senderId, content, createdAt: now }`
- Calls `emitTeamUpdate(teamId, { type: "message", ... })`
- Returns saved message

#### `bulkAssignToMember(teamId, leadIds, memberId, assignedBy)`
- Verifies memberId is in team
- `Lead.updateMany({ _id: { $in: leadIds }, team: teamId }, { $set: { assignedTo: memberId, status: "assigned" } })`
- Calls `notifyBulkLeadAssignment(memberId, count)`
- Returns `{ updated: count }`

#### `bulkTransfer(fromTeamId, toTeamId, leadIds)`
- `Lead.updateMany({ _id: { $in: leadIds } }, { $set: { team: toTeamId, assignedTo: null } })`
- Returns `{ transferred: count }`

#### `bulkUpdateStatus(teamId, leadIds, status)`
- `Lead.updateMany({ _id: { $in: leadIds }, team: teamId }, { $set: { status } })`

#### `getTeamRevenue(teamId, dateRange)`
- Aggregation pipeline on `leads.payments` for team
- Filters by date range, groups by payment mode
- Returns `{ total, byMode: { cash, online, cheque } }`

#### `getTeamRevenueTimeline(teamId, period)`
- Aggregation pipeline grouping payments by day/week/month
- Returns `[{ date, total }]` array for charting

---

## 4. userService.ts

**File**: `src/services/userService.ts`
**Purpose**: User domain CRUD and profile management.
**Model(s) used**: `User`, `Lead`, `Role`
**Utils called**: None directly (bcrypt for password hash on create)
**Called by**: `userController.ts`
**Routes that trigger it**: All routes under `/api/v1/users/*`

### Methods

#### `createUser(data)`
- Validates email uniqueness (throws 409 if exists)
- Hashes password with `bcrypt.hash(data.password, 10)`
- Creates User with `{ name, email, password: hashed, role, status: "active" }`
- Returns user without password (`.select("-password")`)

#### `getUsers(filters, pagination)`
- Lists users with optional role/status/search filters
- Returns paginated list with role populated

#### `getUserById(userId)`
- `User.findById(userId).populate("role").select("-password").lean()`
- Throws 404 if not found

#### `getUserProfile(userId)`
- Same as `getUserById` but may include additional computed fields (team membership, stats)

#### `updateUser(userId, data)`
- Updates allowed fields (name, email, role, status, phone)
- If `data.password` present → hashes before saving
- Throws 404 if not found

#### `deleteUser(userId)`
- Hard delete user
- Does NOT reassign their leads — caller must handle
- Throws 404 if not found

#### `getLeadsByUser(userId, filters, pagination)`
- Finds leads where `assignedTo: userId`
- Returns paginated leads with filters

#### `getUserLeadStats(userId)`
- Aggregation: count leads by status for this user
- Returns `{ total, byStatus: { new, assigned, followup, ... } }`

---

## 5. roleService.ts

**File**: `src/services/roleService.ts`
**Purpose**: Role and permission management.
**Model(s) used**: `Role`
**Utils called**: None
**Called by**: `roleController.ts`
**Routes that trigger it**: All routes under `/api/v1/roles/*`

### Methods

#### `createRole(data)`
- Creates Role with `{ roleName, isSystemRole: false, permissions: data.permissions }`
- Validates that `roleName` is unique (Mongoose unique index also enforces this)
- Returns saved role

#### `getRoles(pagination)`
- Lists all roles with pagination
- Returns `{ roles, pagination }`

#### `getRoleById(roleId)`
- Finds role by ID — throws 404 if not found

#### `getRolesSimple()`
- Returns all roles as `[{ _id, roleName }]` — lean, no pagination
- Used for dropdowns/selects in UI

#### `updateRole(roleId, data)`
- Updates `roleName` and/or `permissions`
- Throws 404 if not found
- Throws 400 if attempting to modify a system role

#### `deleteRole(roleId)`
- Throws 400 if `role.isSystemRole === true` — cannot delete system roles
- Checks if any users have this role (throws 400 if yes)
- Hard deletes role

---

## 6. courseService.ts

**File**: `src/services/courseService.ts`
**Purpose**: Course catalog management.
**Model(s) used**: `Course`
**Utils called**: None
**Called by**: `courseController.ts`
**Routes that trigger it**: All routes under `/api/v1/courses/*`

### Methods

#### `createCourse(data)`
- Creates Course with `{ name, description, price, duration, category }`
- Returns saved course

#### `getCourses(filters, pagination)`
- Lists courses with optional search/category filters
- Returns paginated courses

#### `getAllCourses()`
- Returns ALL courses without pagination — for dropdowns
- `.lean()` for performance

#### `getCourseById(courseId)`
- Finds by ID, throws 404 if not found

#### `updateCourse(courseId, data)`
- Updates any course fields
- Throws 404 if not found

#### `deleteCourse(courseId)`
- Hard delete
- Does NOT check if any leads reference this course — caller responsible
- Throws 404 if not found

---

## 7. reportService.ts

**File**: `src/services/reportService.ts`
**Purpose**: All analytics and reporting — uses MongoDB aggregation pipelines.
**Model(s) used**: `Lead`, `Team`, `User`
**Utils called**: None
**Called by**: `reportController.ts`
**Routes that trigger it**: All routes under `/api/v1/reports/*`

### Methods

#### `getOverview(dateRange, teamId?)`
- Aggregates lead counts by status
- Optionally scoped to a team
- Returns `{ total, byStatus: { new, assigned, followup, ... }, conversionRate }`

#### `getTimeline(period, dateRange, teamId?)`
- Groups lead creation by day/week/month
- Returns `[{ date, count, byStatus }]` for charting

#### `getUserRankings(dateRange, teamId?)`
- Aggregates per-user: lead count, closed count, revenue
- Returns `[{ userId, name, leads, closed, revenue, conversionRate }]` sorted by revenue desc

#### `getTeamRankings(dateRange)`
- Same as user rankings but grouped by team
- Returns `[{ teamId, name, leads, closed, revenue }]`

#### `getTeamSplit(dateRange)`
- Pie chart data: how leads are distributed across teams
- Returns `[{ teamId, name, count, percentage }]`

#### `getRevenueOverview(dateRange, teamId?)`
- Aggregates payment totals from `lead.payments` array
- Returns `{ total, byMode: { cash, online, cheque }, byTeam }`

#### `getRevenueTimeline(period, dateRange)`
- Groups payments by day/week/month
- Returns `[{ date, total }]`

#### `getRevenueTeams(dateRange)`
- Revenue breakdown per team
- Returns `[{ teamId, name, total, byMode }]`

---

## 8. pushService.ts

**File**: `src/services/pushService.ts`
**Purpose**: Web Push (VAPID) notification management — subscribe, unsubscribe, send notifications.
**Model(s) used**: `PushSubscription`
**External library**: `web-push`
**Called by**: `pushController.ts`, `leadService.ts`, `teamService.ts`, `reminderScheduler.ts`
**Routes that trigger it**: `/api/v1/push/*`

### Methods

#### `sendPushToUser(userId, { title, body, tag, url, data })`
- Fetches all `PushSubscription` documents for `userId`
- Calls `webpush.sendNotification(sub, JSON.stringify({ title, body, tag, url, data }))` for each
- Handles expired/invalid subscriptions: on 410 response, deletes the subscription document
- Returns `{ sent: number, failed: number }`

#### `notifyLeadAssignment(userId, leadId, leadName, assignedBy)`
- Wrapper: calls `sendPushToUser(userId, { title: "New Lead Assigned", body: ..., tag: "lead-assign", url: /leads/${leadId} })`

#### `notifyBulkLeadAssignment(userId, count)`
- Wrapper: calls `sendPushToUser(userId, { title: "${count} Leads Assigned", ... })`

#### `subscribePush(userId, subscription)`
- `subscription` = `{ endpoint, keys: { p256dh, auth } }` from browser PushManager
- Upserts `PushSubscription` document: `{ userId, endpoint, keys }` (unique on endpoint)
- Returns saved subscription

#### `unsubscribePush(userId, endpoint)`
- Deletes `PushSubscription` where `userId` AND `endpoint` match
- Returns `{ deleted: boolean }`

#### `getVapidPublicKey()`
- Returns `process.env.VAPID_PUBLIC_KEY`

---

## 9. reminderScheduler.ts

**File**: `src/services/reminderScheduler.ts`
**Purpose**: Background job that checks for due reminders and fires Socket.io + Web Push notifications.
**Model(s) used**: `Lead`
**Utils called**: `emitToUser` from `socket.ts`, `sendPushToUser` from `pushService.ts`
**Called by**: `src/index.ts` (on server start: `startReminderScheduler()`)
**No routes** — runs entirely as a background process

### Methods

#### `startReminderScheduler()`
- Calls `setInterval(tick, 30_000)` (runs every 30 seconds)
- Also runs `tick()` once immediately on startup
- Logs startup

#### `tick()` (internal async function)
- **Pass 1 — On-Time Notifications**:
  - Query: leads where `reminders` contains `{ remindAt: { $lte: now }, isDone: false, notifiedAt: null }`
  - Uses `$elemMatch` for the query predicate
  - For each matching lead, iterates sub-documents that match Pass 1 criteria
  - Calls `emitToUser(reminder.assignedTo, "reminder:due", { ... })`
  - Calls `sendPushToUser(reminder.assignedTo, { title: reminder.title, ... })`
  - Stamps `notifiedAt: now` using `arrayFilters: [{ "r._id": reminder._id }]`

- **Pass 2 — Warning Notifications** (reminders coming up in 1-31 minutes):
  - Query: leads where `reminders` contains `{ remindAt: { $gte: nowPlus1, $lte: nowPlus31 }, isDone: false, warnedAt: null }`
  - For each match: emits `reminder:warning` with `minsLeft` calculated
  - Stamps `warnedAt: now` using `arrayFilters`

---

## 10. excelService.ts

**File**: `src/services/excelService.ts`
**Purpose**: Parses xlsx/csv file buffers, validates rows, returns structured valid/invalid split.
**Model(s) used**: None (pure parsing logic)
**External library**: `exceljs` or `xlsx`
**Called by**: `leadService.ts` → `bulkCreateLeads` (controller passes buffer from multer)

### Methods

#### `parseExcelBuffer(buffer: Buffer, reporterId: string)`
- Reads buffer as xlsx/csv
- Maps each row to a `ParsedLead` object using column index mapping
- **Email validation**: checks against `/^\S+@\S+\.\S+$/` — if value is "No Email", empty, or invalid format → sets `email: undefined` (not stored)
- **Notes validation**: if a notes column exists, wraps as `[{ content: value, author: reporterId }]` array — never a plain string
- **Phone dedup**: checks if phone already exists in DB (optional, may be done in bulkCreateLeads)
- Returns:
  ```typescript
  {
    valid: ParsedLead[],    // rows that passed all validations
    invalid: Array<{
      row: number,
      data: object,
      reason: string
    }>
  }
  ```
- Rows missing required fields (name, phone) go to `invalid`
- Rows with duplicate phones within the same upload go to `invalid`
