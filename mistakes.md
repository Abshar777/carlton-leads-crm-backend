# Carlton CRM — Backend Bugs & Fixes

This file documents every real bug found and fixed in this project. Read this before writing similar code. Every entry shows the root cause, the fix, and the rule to follow.

---

## Bug Template
- **Bug Title**
- **File/Location**: where the bug lived
- **Root Cause**: what caused it
- **Symptom**: what went wrong in runtime
- **Fix**: how it was resolved
- **Rule**: what to always do going forward

---

## Bug #1: Populated ObjectId toString() Returns "[object Object]"

**File/Location**: `src/services/teamService.ts` → `autoAssignTeamLeads()`

**Root Cause**: Mongoose's `populate()` replaces an ObjectId field with the full referenced document. When you call `.toString()` on a Mongoose Document (not an ObjectId), it returns `"[object Object]"` — not the ID string.

**Symptom**: The active member filter in round-robin auto-assignment was comparing against `"[object Object]"` strings, which never matched any real ID. As a result, ALL members were treated as active (the filter excluded nothing), and leaders + inactive members were included in assignment distribution.

**Broken code**:
```typescript
// WRONG — team.inactiveMembers is populated [{_id: ObjectId, name: string, ...}]
const inactiveIds = new Set(team.inactiveMembers.map(m => m.toString()));
// m is a Mongoose Document → m.toString() = "[object Object]"
```

**Fix**:
```typescript
// CORRECT — access ._id first, then toString()
const inactiveIds = new Set(team.inactiveMembers.map(m => m._id.toString()));
const leaderIds = new Set(team.leaders.map(l => l._id.toString()));
const activeMembers = team.members.filter(m =>
  !leaderIds.has(m._id.toString()) && !inactiveIds.has(m._id.toString())
);
```

**Rule**: NEVER call `.toString()` directly on a populated Mongoose document. Always access `._id` first: `doc._id.toString()`. This applies anywhere you compare populated ObjectId fields.

---

## Bug #2: Lead Upload Silent Failure (Notes as Object + Invalid Email)

**File/Location**: `src/services/leadService.ts` → `bulkCreateLeads()` and `src/services/excelService.ts` → `parseExcelBuffer()`

**Root Cause**: Two separate issues in the CSV upload pipeline that caused all rows to silently fail:

**Issue A — Notes as plain string/object**:
The `notes` field on the Lead schema expects an array of objects `[{ content: string, author: ObjectId }]`. The upload code was setting `notes: row.notes` (a plain string from the spreadsheet cell) which failed Mongoose schema validation.

**Issue B — "No Email" string failing validation**:
Some spreadsheets use "No Email" as a placeholder in the email column. The Lead schema validates email format. Passing `"No Email"` caused a Mongoose ValidationError for that field.

**Symptom**: With `insertMany({ ordered: false })`, ALL rows were silently dropped (zero leads created). No error was thrown — just zero documents inserted. The controller returned `{ created: 0 }` with no explanation.

**Broken code**:
```typescript
// WRONG
const docs = rows.map(row => ({
  name: row.name,
  email: row.email,        // "No Email" fails validation
  notes: row.notes,        // plain string, not array
}));
```

**Fix**:
```typescript
// CORRECT
const emailRegex = /^\S+@\S+\.\S+$/;

const docs = rows.map(row => ({
  name: row.name,
  email: emailRegex.test(row.email) ? row.email : undefined,  // undefined if invalid
  notes: row.notes
    ? [{ content: row.notes, author: reporterId }]            // always wrap in array
    : [],
}));
```

**Rule**:
1. Always validate email against `/^\S+@\S+\.\S+$/` before inserting — set to `undefined` if invalid, never store the invalid string.
2. Always set `notes` as an array of objects `[{ content, author }]`, never as a plain string.
3. After `insertMany`, always check `result.length` vs input length to surface failures.

---

## Bug #3: `insertMany` `ordered: false` Silent Failures

**File/Location**: All bulk insert operations — `leadService.ts` `bulkCreateLeads()`

**Root Cause**: `Model.insertMany(docs, { ordered: false })` does NOT throw when individual documents fail validation or violate unique constraints. It silently skips failed documents and returns only the successfully inserted ones. The difference between the input array length and the result array length is the failure count — but only if you check.

**Symptom**: Callers assumed all documents were inserted if no error was thrown. Silent data loss — the user uploaded 50 leads and only 38 were inserted, but the response said "created: 50".

**Broken code**:
```typescript
const result = await Lead.insertMany(docs, { ordered: false });
return { created: result.length }; // never says how many failed
```

**Fix**:
```typescript
const result = await Lead.insertMany(docs, { ordered: false });
const failed = docs.length - result.length;
if (failed > 0) {
  console.warn(`[bulkCreateLeads] ${failed} of ${docs.length} documents failed to insert`);
}
return {
  created: result.length,
  failed,
  errors: invalidRows   // rows rejected during parsing
};
```

**Rule**: After EVERY `insertMany` call, compare `result.length` to the input array length. Log and surface the difference. Never assume all documents were inserted.

---

## Bug #4: JWT Role Loaded Once at Token Issue Time

**File/Location**: `src/middleware/auth.ts` — original version

**Root Cause**: The original `authenticate` middleware decoded the JWT and used the `roleId` from the token payload to check permissions, but did NOT re-fetch the role from the database. The JWT was generated at login time and cached the role state from that moment.

**Symptom**: If an admin updated a role's permissions AFTER a user had already logged in (valid token), the user's permissions in the current session would not reflect the change until their token expired (up to 15 minutes). In some scenarios with long-lived sessions, stale permissions persisted for hours.

**Broken code**:
```typescript
// WRONG — permissions cached in JWT at login time
const decoded = verifyAccessToken(token);
req.user = {
  userId: decoded.userId,
  email: decoded.email,
  roleId: decoded.roleId,
  permissions: decoded.permissions  // stale — from token, not current DB state
};
```

**Fix**:
```typescript
// CORRECT — always load fresh role from DB
const decoded = verifyAccessToken(token);
const user = await User.findById(decoded.userId).select("-password");
const role = await Role.findById(user.role);  // fresh from DB every request
req.user = { userId: user._id.toString(), email: user.email, roleId: role._id.toString(), role };
```

**Rule**: The `authenticate` middleware MUST fetch a fresh Role document from the database on every request. Never rely solely on the JWT payload for permission data. The JWT payload carries `userId`, `email`, `roleId` for identification — permissions must always be loaded fresh.

---

## Bug #5: Reminder `arrayFilters` Missing `_id` Match

**File/Location**: `src/services/reminderScheduler.ts` — initial implementation

**Root Cause**: When updating embedded sub-documents with `arrayFilters`, if the filter is too broad (e.g., only filtering by `remindAt` value), multiple sub-documents might match. The `$set` with positional operator `$[r]` would then update the FIRST matching element, potentially stamping `notifiedAt` on the wrong reminder.

**Symptom**: On leads with multiple reminders at similar times, the wrong reminder was getting stamped as `notifiedAt`. A reminder that fired at 10:00 AM would stamp `notifiedAt` on the reminder at 10:05 AM (first matching). The 10:05 reminder then never fired because it appeared already notified.

**Broken code**:
```typescript
// WRONG — filter by remindAt only, could match multiple reminders
await Lead.updateOne(
  { _id: lead._id },
  { $set: { "reminders.$[r].notifiedAt": now } },
  { arrayFilters: [{ "r.remindAt": { $lte: now }, "r.isDone": false }] }
);
```

**Fix**:
```typescript
// CORRECT — always filter by _id for exact sub-document targeting
await Lead.updateOne(
  { _id: lead._id },
  { $set: { "reminders.$[r].notifiedAt": now } },
  { arrayFilters: [{ "r._id": reminder._id }] }
);
```

**Rule**: Always use `arrayFilters` with `"r._id": subDocumentId` to target the exact embedded sub-document. Never use only value-based filters (like `remindAt` or `status`) in arrayFilters — they can match unintended elements.

---

## Bug #6: `/mine` Route Shadowed by `/:id`

**File/Location**: `src/routes/teamRoutes.ts` — route declaration order

**Root Cause**: Express matches routes in the order they are declared. A parameterized route like `GET /:id` matches ANY string in that position, including literal strings like `"mine"`. If `/:id` is declared before `/mine`, the request `GET /teams/mine` is handled by the `/:id` handler with `req.params.id = "mine"`. Mongoose then tries to cast `"mine"` as an ObjectId, which throws a CastError.

**Symptom**: `GET /teams/mine` returned 400 "Invalid ID format" (or a 500 CastError) instead of returning the current user's team.

**Broken code**:
```typescript
// WRONG — /:id catches everything including /mine
router.get("/:id", authenticate, checkPermission("teams","view"), getTeamById);
router.get("/mine", authenticate, getMyTeam);  // NEVER REACHED
```

**Fix**:
```typescript
// CORRECT — static routes before parameterized routes
router.get("/mine", authenticate, getMyTeam);
router.get("/:id", authenticate, checkPermission("teams","view"), getTeamById);
```

**Rule**: ALL static path segments (`/mine`, `/all`, `/bulk`, `/upload`, `/simple`, `/stats`, `/auto-assign`) MUST be declared BEFORE any parameterized routes (`/:id`, `/:leadId`, `/:teamId`). This applies to ALL routers in the project.

---

## Bug #7: `/bulk` Routes Shadowed by `/:leadId`

**File/Location**: `src/routes/teamRoutes.ts` — nested route declaration order

**Root Cause**: Same underlying issue as Bug #6 but with nested routes. The route `PATCH /teams/:id/leads/bulk/assign` was being matched by `PATCH /teams/:id/leads/:leadId/assign` with `req.params.leadId = "bulk"`. This then tried to find a lead with ID `"bulk"`, which failed.

**Symptom**: `PATCH /teams/:teamId/leads/bulk/assign` returned 404 "Lead not found" or a CastError instead of running bulk assignment.

**Broken code**:
```typescript
// WRONG — /:leadId/assign catches /bulk/assign
router.patch("/:teamId/leads/:leadId/assign", ...handlers);
router.patch("/:teamId/leads/bulk/assign", ...handlers);  // NEVER REACHED
```

**Fix**:
```typescript
// CORRECT — /bulk/* routes before /:leadId routes
router.patch("/:teamId/leads/bulk/assign", authenticate, checkPermission("teams","edit"), bulkAssignToMember);
router.patch("/:teamId/leads/bulk/transfer", authenticate, checkPermission("teams","edit"), bulkTransfer);
router.patch("/:teamId/leads/bulk/status", authenticate, checkPermission("teams","edit"), bulkUpdateStatus);
router.patch("/:teamId/leads/:leadId/assign", authenticate, checkPermission("teams","edit"), assignLeadToMember);
```

**Rule**: Same as Bug #6 — static paths before parameterized paths. For nested routes, check EACH level of nesting for this ordering issue. Always declare `/bulk/...` routes before `/:id/...` routes at the same nesting level.

---

## [2026-04-06] Lead Status enum mismatch — PipelineStage type

**Bug:** When adding `getTeamReminders` aggregation pipeline, typed as `object[]` instead of `PipelineStage[]`. Mongoose aggregation requires the stricter `PipelineStage[]` type from mongoose.
**Fix:** `import { type PipelineStage } from "mongoose"` and typed pipeline as `PipelineStage[]`.
**Also:** `preserveNullAndEmpty` is not valid — correct key is `preserveNullAndEmptyArrays` in `$unwind` stage.
