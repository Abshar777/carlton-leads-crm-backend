# Carlton CRM — Backend Agent Rulebook

## Stack
- **Runtime**: Bun
- **Framework**: Express + TypeScript
- **Database**: MongoDB (Mongoose ODM)
- **Realtime**: Socket.io
- **Validation**: Zod
- **Auth**: JWT (access + refresh tokens via `jsonwebtoken`)
- **Push Notifications**: web-push (VAPID)
- **File Parsing**: exceljs / xlsx
- **Port**: 5001
- **DB URI**: mongodb://localhost:27017/crm_db

## Collections
`users` | `leads` | `teams` | `roles` | `courses` | `aiMemories` | `pushSubscriptions` | `teamMessages`

---

## ⚡ MANDATORY RESPONSE PROTOCOL

This protocol is non-negotiable. Every response that involves code changes MUST follow this sequence:

### Step 1 — Summarize
Before writing any code, write a plain-English summary of:
- What you understood the task to be
- Which files you plan to touch
- Which services/controllers/routes are involved
- Any concerns or ambiguities you noticed

### Step 2 — Ask Doubts
If anything is unclear, ask NOW before writing code. Do not make assumptions silently. Examples of things to ask:
- "Should this route require a specific permission or is selfOrPermission enough?"
- "Should deleted leads be soft-deleted or hard-deleted?"
- "Is this a new endpoint or modifying an existing one?"

### Step 3 — Wait for Confirmation
Do NOT proceed to code until the user confirms the plan or resolves doubts. A thumbs-up or "yes go ahead" is enough.

### Step 4 — Write Code
Only now write the implementation. Follow all conventions in this file.

---

### Step 5 — Sub-Agent Testing (MANDATORY after every code change)

**After writing code, launch a sub-agent to test the change with 4 different cases.**

Every code change — new route, new service method, bug fix, or refactor — must be tested through 4 different scenarios before the task is considered complete.

#### 4 Required Test Cases

| Case | What to test | Goal |
|------|-------------|------|
| **Case 1 — Happy Path** | Valid request with all correct data — the most expected usage | Verify the feature works as intended, returns correct response shape |
| **Case 2 — Edge / Boundary** | Empty arrays, zero counts, missing optional fields, max pagination | Verify limits and optional values are handled without crashing |
| **Case 3 — Invalid Input** | Missing required fields, wrong types, invalid ObjectId, bad dates, constraint violations | Verify Zod validation and Mongoose errors return proper 400/409 responses |
| **Case 4 — Permission / Auth** | No token (401), valid token but wrong role (403), inactive user (403), wrong team membership | Verify middleware chain blocks unauthorized access correctly |

#### Sub-Agent Test Report Format

```
## 🧪 Backend Test Report

**Route/Feature tested:** [METHOD /api/v1/path — Feature name]
**Service method(s):** [ServiceClass.methodName()]
**Date:** [today]

| Case | Input | Expected | Actual | Result |
|------|-------|----------|--------|--------|
| Case 1 — Happy Path | [describe input] | [status + response shape] | [what happened] | ✅ PASS / ❌ FAIL |
| Case 2 — Edge | [describe input] | [status + response shape] | [what happened] | ✅ PASS / ❌ FAIL |
| Case 3 — Invalid | [describe input] | 400/409 + error message | [what happened] | ✅ PASS / ❌ FAIL |
| Case 4 — Permission | [describe input] | 401/403 + error message | [what happened] | ✅ PASS / ❌ FAIL |

**Overall:** ✅ All passed / ⚠️ X failed

**Failures (if any):**
- Case X: [what failed] → [root cause] → [fix applied / needs fix]

**If any case fails:**
→ Fix the issue immediately
→ Re-run all 4 cases
→ Log the bug in `mistakes.md` with the code example
```

#### What the Sub-Agent Checks (Backend-specific)

- **Response shape**: Does the response match `{ success, message, data, pagination? }`?
- **Status codes**: Correct HTTP codes (200, 201, 400, 401, 403, 404, 409, 500)?
- **Middleware chain**: Is `authenticate` applied? Is `checkPermission` with the right module/action applied?
- **Mongoose queries**: Does `.lean()` exist on read-only queries? Is `-password` excluded?
- **Array operations**: Are `$elemMatch` + `arrayFilters` used for embedded array updates?
- **Route ordering**: Are static routes (`/mine`, `/all`, `/bulk`) defined before `/:id` routes?
- **insertMany**: After bulk ops, is `result.length` compared against input to detect silent failures?
- **Socket events**: Is `emitToUser` or `emitTeamUpdate` called after relevant mutations?
- **Activity logs**: Is `lead.activityLogs` pushed for all lead mutations?
- **IST dates**: Are reminder times stored as UTC but validated as IST-aware?

#### How to Run Backend Tests

Use the existing test infrastructure in `backend/tests/`:

```bash
# Run all tests
bun test tests/ --timeout 15000

# Run specific module tests
bun test tests/teams/ --timeout 15000
bun test tests/leads/ --timeout 15000

# Verbose output
bun test tests/ --timeout 15000 --reporter=verbose
```

For new features without existing tests — the sub-agent must **create** the test file in `backend/tests/[module]/[feature].test.ts` before running it.

#### Test File Naming Convention

```
backend/tests/
├── teams/
│   ├── auto-assign.test.ts
│   └── member-toggle.test.ts
├── leads/
│   ├── upload.test.ts
│   └── reminders.test.ts
├── users/
│   └── permissions.test.ts
└── helpers/
    ├── auth.ts        # getToken(), api() fetch wrapper
    └── factory.ts     # createTestLead(), createTestTeam(), cleanup helpers
```

#### When to Run Tests

- After every new route is added
- After every service method is created or modified
- After every bug fix
- After every middleware change
- After any Mongoose schema change
- **Never close a task without all 4 cases passing**

---

### Step 6 — Post-Change Report
After writing code and all 4 test cases pass, provide a concise report:
- Files created or modified (with absolute paths)
- New routes added (method + path + middleware chain)
- New socket events added (if any)
- Database schema changes (if any)
- Which .md files were updated
- Test results summary (4 cases, all pass/fail)

---

## 🔁 Mandatory Workflow — Before Writing Any Code

**Always check these files in order before writing any backend code:**

1. **`mistakes.md`** — Is there a known bug related to what you're about to implement? Check before touching Mongoose embedded arrays, bulk inserts, route ordering, or permissions.
2. **`servicesHistory.md`** — Does the service method you're about to write already exist? Never duplicate service methods.
3. **`logicHistory.md`** — Is the business logic you're about to implement already documented? Use the existing algorithm.
4. **`middlewareHistory.md`** — What is the correct middleware chain for this route? Check the permission matrix.
5. **`socketHistory.md`** — Does the socket event you're about to emit already exist? Use the existing event name and payload shape.
6. **Write the code** — following all rules in this file.
7. **Update the relevant .md files** — after every change, update whichever history files are affected.

---

## Project File Structure

```
backend/
├── src/
│   ├── index.ts                  # Entry point: Express app setup, DB connect, httpServer, Socket init
│   ├── socket.ts                 # Socket.IO init, auth middleware, emitToUser, emitTeamUpdate helpers
│   │
│   ├── controllers/              # Thin request handlers — validate input, call service, send response
│   │   ├── authController.ts     # login, refreshToken, getProfile, changePassword
│   │   ├── leadController.ts     # All lead CRUD, status, assign, notes, bulk ops, reminders, payments
│   │   ├── teamController.ts     # All team CRUD, member management, auto-assign, revenue, chat
│   │   ├── userController.ts     # User CRUD, profile, lead stats
│   │   ├── roleController.ts     # Role CRUD
│   │   ├── courseController.ts   # Course CRUD
│   │   ├── reportController.ts   # Overview, timeline, rankings, revenue analytics
│   │   ├── aiController.ts       # AI chat (lead/team/report contexts), memory CRUD
│   │   ├── pushController.ts     # VAPID public key, subscribe, unsubscribe
│   │   └── sheetsController.ts   # Google Sheets sync (single + batch upsert)
│   │
│   ├── services/                 # All business logic — controllers call these
│   │   ├── authService.ts        # Auth logic: login, token refresh, profile, password change
│   │   ├── leadService.ts        # Lead domain: CRUD, status, assign, notes, bulk, reminders, payments
│   │   ├── teamService.ts        # Team domain: CRUD, members, auto-assign, revenue, messages
│   │   ├── userService.ts        # User domain: CRUD, lead stats
│   │   ├── roleService.ts        # Role domain: CRUD
│   │   ├── courseService.ts      # Course domain: CRUD
│   │   ├── reportService.ts      # Analytics: aggregation pipelines for all report types
│   │   ├── pushService.ts        # Web Push: send notifications, subscribe/unsubscribe
│   │   ├── excelService.ts       # Parse xlsx/csv buffers, validate rows, return valid/invalid
│   │   └── reminderScheduler.ts  # setInterval tick: fires reminder:due + reminder:warning events
│   │
│   ├── models/                   # Mongoose schemas + model exports
│   │   ├── User.ts               # User schema (name, email, password, role, status, team)
│   │   ├── Lead.ts               # Lead schema (all fields, embedded notes/reminders/payments/activityLogs)
│   │   ├── Team.ts               # Team schema (name, members, leaders, inactiveMembers)
│   │   ├── Role.ts               # Role schema (roleName, isSystemRole, permissions map)
│   │   ├── Course.ts             # Course schema (name, description, price, duration)
│   │   ├── AiMemory.ts           # AI conversation history per {contextType, contextId, userId}
│   │   ├── PushSubscription.ts   # Web Push subscriptions per user (endpoint + keys)
│   │   └── TeamMessage.ts        # Team chat messages (teamId, sender, content, createdAt)
│   │
│   ├── routes/                   # Express routers — wire paths to controllers + middleware
│   │   ├── authRoutes.ts         # /auth/* — public routes (no auth required)
│   │   ├── leadRoutes.ts         # /leads/* — all lead routes
│   │   ├── teamRoutes.ts         # /teams/* — all team routes
│   │   ├── userRoutes.ts         # /users/* — user routes with selfOrPermission
│   │   ├── userLeadRoutes.ts     # /users/:userId/leads — leads by user
│   │   ├── roleRoutes.ts         # /roles/* — role management
│   │   ├── courseRoutes.ts       # /courses/* — course management
│   │   ├── reportRoutes.ts       # /reports/* — analytics
│   │   ├── aiRoutes.ts           # /ai/* — AI chat and memory
│   │   ├── pushRoutes.ts         # /push/* — Web Push VAPID + subscribe
│   │   └── sheetsRoutes.ts       # /sheets/* — Google Sheets sync (API key auth)
│   │
│   ├── middleware/               # Express middleware
│   │   ├── auth.ts               # authenticate — JWT verify + user/role DB fetch
│   │   ├── permissions.ts        # checkPermission(module, action), requireModule(module)
│   │   ├── apiKeyAuth.ts         # authenticateApiKey — for /sheets/* routes
│   │   └── errorHandler.ts       # errorHandler (global), notFound (404)
│   │
│   ├── types/
│   │   └── index.ts              # All shared TypeScript interfaces and enums
│   │
│   ├── validations/              # Zod schemas for request body/query/params validation
│   │   ├── authValidation.ts
│   │   ├── leadValidation.ts
│   │   ├── teamValidation.ts
│   │   ├── userValidation.ts
│   │   ├── roleValidation.ts
│   │   └── courseValidation.ts
│   │
│   └── utils/
│       ├── jwt.ts                # generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken
│       └── response.ts           # sendSuccess, sendError, buildPagination
│
├── AGENTS.md                     # This file — agent rulebook
├── mistakes.md                   # All known bugs and fixes
├── servicesHistory.md            # All service files and their methods
├── logicHistory.md               # All business logic implementations
├── features.md                   # All backend features, routes, services, models
├── socketHistory.md              # Socket.IO events, rooms, Web Push
└── middlewareHistory.md          # Middleware stack, permission matrix, access control
```

---

## Code Quality Rules

### TypeScript
- **Zero `any`** — never use `any` in TypeScript. Use proper types from `src/types/index.ts`.
- If a type doesn't exist yet, add it to `types/index.ts` before using it.
- Use `unknown` if you genuinely don't know the shape, then narrow it.
- Use generics where appropriate (e.g., `sendSuccess<T>(res, data: T, message)`).

### Route Protection
- **All routes** must use `authenticate` + `checkPermission(module, action)` EXCEPT:
  - Public auth routes: `POST /auth/login`, `POST /auth/refresh`
  - `selfOrPermission` routes: `GET /users/:id` (user viewing own profile)
  - Sheets routes: use `authenticateApiKey` instead
  - Team member detail routes: guarded at service layer (checks team membership)
- Never expose a route without at least `authenticate`.

### Response Helpers
- **Always** use `sendSuccess(res, message, data, status)` or `sendError(res, message, status)` from `utils/response.ts`.
- Never use `res.json()` or `res.status(200).json()` directly.
- Never use `res.status(500)` directly in controllers — throw errors and let `errorHandler` handle them.

### Controllers Are Thin
- Controllers do exactly three things: validate input, call service, send response.
- No database queries in controllers.
- No business logic in controllers.
- If it's more than ~15 lines of logic, it belongs in a service.

### Validation
- All input validation via Zod schemas in `validations/`.
- Validate `req.body`, `req.query`, and `req.params` where relevant.
- Throw a 400 error (or use `sendError`) if validation fails — don't pass invalid data to services.

### Mongoose Query Rules
- **Always use `.lean()`** for read-only queries that don't call `.save()`.
  - `.lean()` returns plain JS objects, not Mongoose Documents — faster and less memory.
  - Example: `await Lead.find({ ... }).lean()` for listing leads.
- **Only use full Documents** when you need to call `.save()` on the instance.
- **Never return passwords** — always use `.select("-password")` on User queries.
- **Pagination** — use `buildPagination(total, page, limit)` from `utils/response.ts`.
- **Case-insensitive search** — use `new RegExp(search, "i")` for string fields.
- For embedded array updates, always use `$elemMatch` in queries and `arrayFilters` in updates.

---

## Permission System

### CrmModule Types
```
"dashboard" | "users" | "roles" | "leads" | "teams" | "courses" | "reminders" | "reports" | "settings"
```

### PermissionAction Types
```
"view" | "create" | "edit" | "delete" | "approve" | "export"
```

### Permission Storage
Permissions are stored on the `Role` document as a nested object:
```json
{
  "permissions": {
    "leads": { "view": true, "create": true, "edit": true, "delete": false },
    "users": { "view": false, "create": false, "edit": false, "delete": false }
  }
}
```

### checkPermission(module, action)
- Middleware factory — returns an Express middleware function.
- Must run AFTER `authenticate` (requires `req.user.role` to be populated).
- Checks `req.user.role.permissions[module][action] === true`.
- Returns 403 if check fails.

### requireModule(module)
- Checks if user has ANY truthy permission on the given module.
- Use when you want to guard a resource without specifying which action.

### Super Admin Bypass
- If `role.isSystemRole === true` AND `role.roleName === "Super Admin"` → skip all permission checks, always proceed.
- This check happens at the TOP of both `checkPermission` and `requireModule`.

### selfOrPermission
- Not a standalone middleware file — defined inline in `userRoutes.ts`.
- If `req.user.userId === req.params.id` → `next()` immediately (user viewing their own record).
- Otherwise → run `checkPermission("users", "view")`.
- This allows any authenticated user to view their own profile without needing `users:view`.

---

## Naming Conventions

### Controllers
- Function names: `verbNoun` camelCase
- Examples: `getLeads`, `createLead`, `updateLeadStatus`, `deleteLead`, `bulkUpdateStatus`, `assignLeadToTeam`
- Each controller function is exported named, not default export.

### Services
- Organized as classes with methods, one class per domain.
- Class name: `LeadService`, `TeamService`, `UserService`, etc.
- Methods: `verbNoun` camelCase — same convention as controllers.
- Instantiated and exported as a singleton: `export const leadService = new LeadService()`.

### Models
- PascalCase: `Lead`, `Team`, `User`, `Role`, `Course`, `AiMemory`, `PushSubscription`, `TeamMessage`
- Schema variable: `leadSchema`, exported model: `Lead`
- Interface/type: `ILead`, `ITeam`, `IUser` (in `types/index.ts`)

### Routes
- URL paths: kebab-case — e.g., `/bulk-assign`, `/auto-assign`, `/team-messages`
- Route files: `leadRoutes.ts`, `teamRoutes.ts`
- Router variable: `const router = Router()`; default export.

### Files
- All files: camelCase — `authService.ts`, `leadController.ts`, `reminderScheduler.ts`
- Middleware files: descriptive noun — `auth.ts`, `permissions.ts`, `errorHandler.ts`

---

## Error Handling

### The Rule
**Never** use `res.status(500).json(...)` directly in controllers or services.

### How to Throw Errors
Throw an object with a `statusCode` property and `message`:
```typescript
const err = new Error("Lead not found") as any;
err.statusCode = 404;
throw err;
```

Or use a helper:
```typescript
function createError(message: string, statusCode: number): Error {
  const err = new Error(message) as any;
  err.statusCode = statusCode;
  return err;
}
throw createError("Unauthorized", 401);
```

### errorHandler Middleware
The global `errorHandler` in `middleware/errorHandler.ts` catches all thrown errors and maps them:
- `ValidationError` (Mongoose) → 400 with field-level messages
- Duplicate key error (code 11000) → 409 "{field} already exists"
- `CastError` (invalid ObjectId) → 400 "Invalid ID format"
- Any error with `.statusCode` property → uses that status code
- Everything else in production → 500 "Internal server error" (hides implementation details)

### 404 Handler
`notFound` middleware is mounted last. Returns 404 "Route not found" for any unmatched path.

---

## MongoDB / Mongoose Rules

### Embedded Array Updates
Always use `$elemMatch` in the query filter AND `arrayFilters` in the update for embedded document updates:
```typescript
await Lead.updateOne(
  { _id: leadId, "reminders": { $elemMatch: { _id: reminderId } } },
  { $set: { "reminders.$[r].notifiedAt": new Date() } },
  { arrayFilters: [{ "r._id": reminderId }] }
);
```
Never use positional `$` operator without verifying it matches the correct element.

### Populated ObjectId toString()
When you populate a field (e.g., `team.members` populated with User documents), calling `.toString()` on the populated document object returns `"[object Object]"` not the ID string.

**Wrong:**
```typescript
team.inactiveMembers.map(m => m.toString()) // "[object Object]"
```

**Correct:**
```typescript
team.inactiveMembers.map(m => m._id.toString()) // "507f1f77bcf86cd799439011"
```

Rule: always access `._id` before calling `.toString()` on any potentially-populated Mongoose field.

### insertMany with ordered: false
`insertMany` with `ordered: false` silently skips failed documents and does NOT throw. Always check the result:
```typescript
const result = await Lead.insertMany(docs, { ordered: false });
const failed = docs.length - result.length;
if (failed > 0) {
  console.warn(`${failed} documents failed to insert`);
}
```

### Route Ordering — Static Before Parameterized
Express matches routes in declaration order. Static paths MUST be declared before parameterized paths:
```typescript
// CORRECT
router.get("/mine", authenticate, getMyLeads);
router.post("/upload", authenticate, uploadLead);
router.get("/:id", authenticate, getLead);

// WRONG — /mine gets matched as /:id with id="mine"
router.get("/:id", authenticate, getLead);
router.get("/mine", authenticate, getMyLeads); // never reached
```
**Rule**: Always declare `/mine`, `/all`, `/bulk`, `/upload`, `/stats`, `/simple` BEFORE `/:id` or `/:leadId` routes.

### Lean Queries
```typescript
// Read-only list — always lean
const leads = await Lead.find({ team: teamId }).lean();

// Need to call .save() — do NOT lean
const lead = await Lead.findById(id); // full Document
lead.status = "closed";
await lead.save();
```

### Case-Insensitive Search
```typescript
// Always use RegExp for text search — never use $text unless you have a text index
const regex = new RegExp(search, "i");
const leads = await Lead.find({ name: regex }).lean();
```

---

## IST Timezone Rules

All reminder times are stored in MongoDB as UTC. The frontend sends times in IST (+5:30) and the backend must convert.

### Parsing IST → UTC for Storage
When receiving a `remindAt` timestamp from the frontend (sent as IST ISO string):
```typescript
const remindAtUTC = new Date(remindAtIST);
// JS Date parsing handles the offset if the ISO string includes +05:30
// If the frontend sends a naive timestamp, subtract 330 minutes:
// const remindAtUTC = new Date(remindAtIST.getTime() - 330 * 60 * 1000);
```

### Scheduler Comparisons
The reminder scheduler compares `remindAt` (stored UTC) against `new Date()` (UTC) — no conversion needed in the scheduler itself.

### Response Format
Return `remindAt` as an ISO UTC string. The frontend is responsible for displaying it in IST.

---

## File References

| File | When to Read |
|------|-------------|
| `mistakes.md` | Before writing any service method, bulk operation, route definition, or embedded array update |
| `servicesHistory.md` | Before creating any new service method — check if it already exists |
| `logicHistory.md` | Before implementing any business logic — check if the algorithm is already documented |
| `middlewareHistory.md` | Before adding any route — check the correct middleware chain and permission matrix |
| `socketHistory.md` | Before emitting any socket event — check existing event names and payload shapes |
| `features.md` | Before implementing any feature — understand the full scope and related features |
