# Carlton CRM — Backend Features

This file documents every backend feature. Read this before implementing anything to understand scope, middleware chains, and related features.

---

## Feature Template

Each feature documents:
- **Description**: What this feature does
- **Routes**: Method, path, full middleware chain
- **Service Methods**: Which service methods are called
- **Models Used**: Which Mongoose models are read/written
- **Socket Events**: Any Socket.io events emitted
- **Related Features**: Which features interact with this one
- **Change Log**: History of changes

---

## 1. Authentication

**Description**: Login with email/password, get JWT tokens, refresh access token, view own profile, change password.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| POST | `/api/v1/auth/login` | (none — public) |
| POST | `/api/v1/auth/refresh` | (none — public) |
| GET | `/api/v1/auth/profile` | `authenticate` |
| PUT | `/api/v1/auth/change-password` | `authenticate` |

**Service Methods**: `authService.login`, `authService.refreshToken`, `authService.getProfile`, `authService.changePassword`

**Models Used**: `User` (read + write for password change), `Role` (read for auth middleware)

**Socket Events**: None

**Related Features**: All protected features (authenticate is the gateway), Role & Permission Management (role loaded fresh per request)

**Change Log**:
- Initial implementation — login + JWT tokens
- Added role loading in authenticate middleware (load fresh from DB, not from token)
- Added inactive user check in authenticate middleware

---

## 2. Lead Management

**Description**: Full CRUD for leads including status updates, field editing, single assignment to users/teams, and activity log tracking.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/leads` | `authenticate`, `checkPermission("leads","view")` |
| POST | `/api/v1/leads` | `authenticate`, `checkPermission("leads","create")` |
| GET | `/api/v1/leads/:id` | `authenticate`, `checkPermission("leads","view")` |
| PUT | `/api/v1/leads/:id` | `authenticate`, `checkPermission("leads","edit")` |
| DELETE | `/api/v1/leads/:id` | `authenticate`, `checkPermission("leads","delete")` |
| PATCH | `/api/v1/leads/:id/status` | `authenticate`, `checkPermission("leads","edit")` |
| POST | `/api/v1/leads/:id/assign` | `authenticate`, `checkPermission("leads","edit")` |
| POST | `/api/v1/leads/:id/assign-team` | `authenticate`, `checkPermission("leads","edit")` |
| POST | `/api/v1/leads/:id/transfer-team` | `authenticate`, `checkPermission("leads","edit")` |

**Service Methods**: `leadService.createLead`, `leadService.getLeads`, `leadService.getLead`, `leadService.updateLead`, `leadService.deleteLead`, `leadService.updateLeadStatus`, `leadService.assignLead`, `leadService.assignLeadToTeam`, `leadService.transferLeadToTeam`

**Models Used**: `Lead` (all), `User` (assignedTo populate), `Team` (team populate), `Course` (course populate)

**Socket Events**: `lead:assigned` — emitted when a lead is assigned to a user (emitted to assignee's private room)

**Related Features**: Lead Upload (#3), Lead Auto-Assignment (#4), Reminder System (#5), Payment Tracking (#6), Team Management (#7)

**Change Log**:
- Initial CRUD implementation
- Added activityLogs tracking on every mutation
- Added `lead:assigned` socket event on assignment
- Added push notification on assignment via pushService

---

## 3. Lead Upload (CSV/Excel Bulk Import)

**Description**: Upload an xlsx/csv file of leads; parse, validate, and bulk-insert. Returns count of created vs failed rows.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| POST | `/api/v1/leads/upload` | `authenticate`, `checkPermission("leads","create")`, `multer.single("file")` |

**Note**: `/upload` route MUST be declared before `/:id` in the router — see mistakes.md #6.

**Service Methods**: `leadService.bulkCreateLeads`, `excelService.parseExcelBuffer`

**Models Used**: `Lead`

**Socket Events**: None

**Related Features**: Lead Management (#2), Lead Auto-Assignment (#4)

**Change Log**:
- Initial implementation with xlsx parsing
- Fixed notes field — must be array, not string (see mistakes.md #2)
- Fixed email validation — "No Email" now stored as undefined (see mistakes.md #2)
- Added `ordered: false` for partial success on insertMany
- Added result.length check to count actual failures

---

## 4. Lead Auto-Assignment (Global)

**Description**: Automatically distribute unassigned leads to team members using round-robin algorithm. Global version (not team-scoped).

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| POST | `/api/v1/leads/auto-assign` | `authenticate`, `checkPermission("leads","edit")` |

**Note**: `/auto-assign` route MUST be declared before `/:id` in the router.

**Service Methods**: `leadService.autoAssignLeads`

**Models Used**: `Lead`, `Team`, `User`

**Socket Events**: `lead:assigned` — emitted per assignment to each assignee

**Related Features**: Team Auto-Assign (#8), Team Management (#7)

**Change Log**:
- Initial round-robin implementation
- Fixed populated ObjectId toString() bug (see mistakes.md #1)

---

## 5. Reminder System

**Description**: Leads can have multiple time-based reminders. Background scheduler fires socket + push notifications when reminders are due or upcoming.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/leads/reminders/mine` | `authenticate` |
| GET | `/api/v1/leads/reminders/count` | `authenticate` |
| POST | `/api/v1/leads/:id/reminders` | `authenticate`, `checkPermission("reminders","create")` |
| PUT | `/api/v1/leads/:id/reminders/:reminderId` | `authenticate`, `checkPermission("reminders","edit")` |
| DELETE | `/api/v1/leads/:id/reminders/:reminderId` | `authenticate`, `checkPermission("reminders","edit")` |

**Note**: `/reminders/mine` and `/reminders/count` MUST be declared before `/:id` — static before parameterized.

**Service Methods**: `leadService.getMyReminders`, `leadService.getMyReminderCount`, `leadService.addReminder`, `leadService.updateReminder`, `leadService.deleteReminder`

**Background**: `reminderScheduler.ts` — runs every 30s via `setInterval`

**Models Used**: `Lead` (reminders embedded array)

**Socket Events**:
- `reminder:due` — emitted by scheduler when reminder passes due time
- `reminder:warning` — emitted by scheduler when reminder is 1-31 minutes away

**Related Features**: Lead Management (#2) — reminders are embedded in leads; Push Notifications (#15)

**Change Log**:
- Initial reminder CRUD
- Added scheduler with two-pass notification system
- Fixed arrayFilters bug — must include `_id` match (see mistakes.md #5)
- Added push notification alongside socket event

---

## 6. Payment Tracking

**Description**: Per-lead payment recording. Each lead can have multiple payment records (amount, mode, date, note).

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| POST | `/api/v1/leads/:id/payments` | `authenticate`, `checkPermission("leads","edit")` |
| PUT | `/api/v1/leads/:id/payments/:paymentId` | `authenticate`, `checkPermission("leads","edit")` |
| DELETE | `/api/v1/leads/:id/payments/:paymentId` | `authenticate`, `checkPermission("leads","delete")` |

**Service Methods**: `leadService.addPayment`, `leadService.updatePayment`, `leadService.deletePayment`

**Models Used**: `Lead` (payments embedded array)

**Socket Events**: None

**Related Features**: Reports & Analytics (#13) — revenue reports aggregate from payment records; Team Management (#7) — team revenue uses these records

**Change Log**:
- Initial payment CRUD implementation

---

## 7. Team Management

**Description**: Full CRUD for teams, member management, team lead lists, team dashboard, activity logs.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/teams` | `authenticate`, `checkPermission("teams","view")` |
| POST | `/api/v1/teams` | `authenticate`, `checkPermission("teams","create")` |
| GET | `/api/v1/teams/mine` | `authenticate` |
| GET | `/api/v1/teams/:id` | `authenticate`, `checkPermission("teams","view")` |
| PUT | `/api/v1/teams/:id` | `authenticate`, `checkPermission("teams","edit")` |
| DELETE | `/api/v1/teams/:id` | `authenticate`, `checkPermission("teams","delete")` |
| GET | `/api/v1/teams/:id/leads` | `authenticate`, `checkPermission("teams","view")` |
| GET | `/api/v1/teams/:id/stats` | `authenticate`, `checkPermission("teams","view")` |
| GET | `/api/v1/teams/:id/dashboard` | `authenticate`, `checkPermission("teams","view")` |
| GET | `/api/v1/teams/:id/logs` | `authenticate`, `checkPermission("teams","view")` |
| GET | `/api/v1/teams/:id/revenue` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/teams/:id/revenue/timeline` | `authenticate`, `checkPermission("reports","view")` |

**Note**: `/mine` MUST be declared before `/:id` — static before parameterized (see mistakes.md #6).

**Service Methods**: `teamService.createTeam`, `teamService.getTeams`, `teamService.getTeamByMember`, `teamService.getTeamById`, `teamService.updateTeam`, `teamService.deleteTeam`, `teamService.getTeamLeads`, `teamService.getTeamMemberStats`, `teamService.getTeamDashboard`, `teamService.getTeamLogs`, `teamService.getTeamRevenue`, `teamService.getTeamRevenueTimeline`

**Models Used**: `Team`, `Lead`, `User`

**Socket Events**: None for basic CRUD

**Related Features**: Team Auto-Assign (#8), Team Activity Feed + Chat (#9), Reports (#13)

**Change Log**:
- Initial team CRUD
- Added `/mine` route for team leaders to see their own team
- Added revenue endpoints
- Added dashboard endpoint

---

## 8. Team Auto-Assign

**Description**: Distribute unassigned team leads to active (non-leader, non-inactive) members using round-robin algorithm.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| POST | `/api/v1/teams/:id/auto-assign` | `authenticate`, `checkPermission("teams","edit")` |
| POST | `/api/v1/teams/:id/members/:memberId/assign` | `authenticate`, `checkPermission("teams","edit")` |
| PATCH | `/api/v1/teams/:id/members/:memberId/toggle-active` | `authenticate`, `checkPermission("teams","edit")` |

**Service Methods**: `teamService.autoAssignTeamLeads`, `teamService.assignLeadToMember`, `teamService.toggleMemberActive`

**Models Used**: `Team`, `Lead`

**Socket Events**: `lead:assigned` — emitted per assignment

**Related Features**: Lead Management (#2), Team Management (#7)

**Change Log**:
- Initial round-robin implementation
- Fixed populated ObjectId toString() bug on inactiveMembers (see mistakes.md #1)
- Added toggleMemberActive with `$addToSet`/`$pull`

---

## 9. Team Activity Feed + Chat

**Description**: Team-scoped activity feed showing recent lead changes, plus a real-time team chat.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/teams/:id/updates` | `authenticate`, `checkPermission("teams","view")` |
| POST | `/api/v1/teams/:id/messages` | `authenticate` |
| GET | `/api/v1/teams/:id/messages` | `authenticate` |

**Service Methods**: `teamService.getTeamUpdates`, `teamService.postTeamMessage`

**Models Used**: `Team`, `TeamMessage`, `Lead` (for activity feed)

**Socket Events**: `team:update` — emitted to `team:{teamId}` room when new message or activity occurs

**Related Features**: Team Management (#7)

**Change Log**:
- Initial team messages implementation
- Added socket emission on new message

---

## 10. User Management

**Description**: Admin CRUD for users. Any authenticated user can view their own profile via selfOrPermission.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/users` | `authenticate`, `checkPermission("users","view")` |
| POST | `/api/v1/users` | `authenticate`, `checkPermission("users","create")` |
| GET | `/api/v1/users/:id` | `authenticate`, `selfOrPermission` |
| PUT | `/api/v1/users/:id` | `authenticate`, `checkPermission("users","edit")` |
| DELETE | `/api/v1/users/:id` | `authenticate`, `checkPermission("users","delete")` |

**Service Methods**: `userService.createUser`, `userService.getUsers`, `userService.getUserById`, `userService.updateUser`, `userService.deleteUser`

**Models Used**: `User`, `Role`

**Socket Events**: None

**Related Features**: Authentication (#1) — same User model; Role & Permission Management (#11)

**Change Log**:
- Initial implementation
- Added selfOrPermission for own-profile access without users:view
- Fixed `/mine` route shadowing — selfOrPermission handles own profile

---

## 11. Role & Permission Management

**Description**: Admin management of roles and their permission sets.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/roles` | `authenticate`, `checkPermission("roles","view")` |
| GET | `/api/v1/roles/simple` | `authenticate` |
| POST | `/api/v1/roles` | `authenticate`, `checkPermission("roles","create")` |
| GET | `/api/v1/roles/:id` | `authenticate`, `checkPermission("roles","view")` |
| PUT | `/api/v1/roles/:id` | `authenticate`, `checkPermission("roles","edit")` |
| DELETE | `/api/v1/roles/:id` | `authenticate`, `checkPermission("roles","delete")` |

**Note**: `/simple` MUST be declared before `/:id`.

**Service Methods**: `roleService.createRole`, `roleService.getRoles`, `roleService.getRolesSimple`, `roleService.getRoleById`, `roleService.updateRole`, `roleService.deleteRole`

**Models Used**: `Role`, `User` (check before delete)

**Socket Events**: None

**Related Features**: Authentication (#1) — roles are loaded fresh on every request; User Management (#10) — users are assigned roles

**Change Log**:
- Initial implementation
- Added guard: cannot delete role if users assigned to it
- Added guard: cannot delete or modify system roles

---

## 12. Course Management

**Description**: CRUD for the course catalog. Courses are referenced by leads.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/courses` | `authenticate`, `checkPermission("courses","view")` |
| GET | `/api/v1/courses/all` | `authenticate` |
| POST | `/api/v1/courses` | `authenticate`, `checkPermission("courses","create")` |
| GET | `/api/v1/courses/:id` | `authenticate`, `checkPermission("courses","view")` |
| PUT | `/api/v1/courses/:id` | `authenticate`, `checkPermission("courses","edit")` |
| DELETE | `/api/v1/courses/:id` | `authenticate`, `checkPermission("courses","delete")` |

**Note**: `/all` MUST be declared before `/:id`.

**Service Methods**: `courseService.createCourse`, `courseService.getCourses`, `courseService.getAllCourses`, `courseService.getCourseById`, `courseService.updateCourse`, `courseService.deleteCourse`

**Models Used**: `Course`

**Socket Events**: None

**Related Features**: Lead Management (#2) — leads reference courses

**Change Log**:
- Initial implementation

---

## 13. Reports & Analytics

**Description**: Aggregated analytics — lead overview, timeline charts, user/team rankings, revenue breakdown.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/reports/overview` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/reports/timeline` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/reports/user-rankings` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/reports/team-rankings` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/reports/team-split` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/reports/revenue` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/reports/revenue/timeline` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/reports/revenue/teams` | `authenticate`, `checkPermission("reports","view")` |

**Service Methods**: `reportService.getOverview`, `reportService.getTimeline`, `reportService.getUserRankings`, `reportService.getTeamRankings`, `reportService.getTeamSplit`, `reportService.getRevenueOverview`, `reportService.getRevenueTimeline`, `reportService.getRevenueTeams`

**Models Used**: `Lead`, `Team`, `User` (via aggregation pipelines)

**Socket Events**: None

**Related Features**: Payment Tracking (#6) — revenue reports read payment data; Team Management (#7)

**Change Log**:
- Initial overview + timeline implementation
- Added user and team rankings
- Added revenue endpoints
- Added team split chart endpoint

---

## 14. AI Chat Assistant

**Description**: Claude AI assistant with context-aware conversations (lead, team, report contexts). Conversation memory persisted per user+context.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| POST | `/api/v1/ai/chat/lead/:leadId` | `authenticate` |
| POST | `/api/v1/ai/chat/team/:teamId` | `authenticate` |
| POST | `/api/v1/ai/chat/report` | `authenticate` |
| GET | `/api/v1/ai/memory/:leadId` | `authenticate` |
| DELETE | `/api/v1/ai/memory/:leadId` | `authenticate` |

**Service Methods**: AI logic in `aiController.ts` (or dedicated aiService)

**Models Used**: `AiMemory`, `Lead`, `Team`

**Socket Events**: None (streaming not implemented — request/response)

**Related Features**: Lead Management (#2) — lead context reads lead data; Team Management (#7)

**Change Log**:
- Initial implementation with lead context
- Added team context
- Added report context
- Added memory CRUD (view + delete conversation)

---

## 15. Push Notifications

**Description**: Web Push (VAPID) notification delivery. Users subscribe their browser and receive push notifications for lead assignments and reminders.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/push/vapid-public-key` | `authenticate` |
| POST | `/api/v1/push/subscribe` | `authenticate` |
| DELETE | `/api/v1/push/unsubscribe` | `authenticate` |

**Service Methods**: `pushService.getVapidPublicKey`, `pushService.subscribePush`, `pushService.unsubscribePush`

**Models Used**: `PushSubscription`

**Socket Events**: None (Push is separate transport from Socket.io)

**Related Features**: Reminder System (#5) — scheduler calls pushService for reminder notifications; Lead Management (#2) — assignment calls pushService

**Change Log**:
- Initial VAPID implementation
- Added auto-cleanup of expired subscriptions (delete on 410 response)

---

## 16. Google Sheets Sync

**Description**: API key authenticated endpoint for Google Apps Script to push lead data from Google Sheets into the CRM. Supports single and batch upsert.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| POST | `/api/sheets/sync` | `authenticateApiKey` |
| POST | `/api/sheets/sync/batch` | `authenticateApiKey` |

**Note**: These routes are under `/api/sheets/` (NOT `/api/v1/`) to keep them simple for Apps Script integration.

**Service Methods**: Implemented inline in `sheetsController.ts` or a dedicated `sheetsService.ts`

**Models Used**: `Lead`, `Course` (name lookup)

**Socket Events**: None

**Related Features**: Lead Management (#2) — creates/updates the same Lead documents

**Change Log**:
- Initial single row sync
- Added batch endpoint
- Added authenticateApiKey middleware

---

## 17. PDF Export

**Description**: Export team or user lead data as a PDF document.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/teams/:id/export/pdf` | `authenticate`, `checkPermission("reports","export")` |
| GET | `/api/v1/users/:id/export/pdf` | `authenticate`, `checkPermission("reports","export")` |

**Service Methods**: PDF generation logic (uses a PDF library such as `pdfkit` or `puppeteer`)

**Models Used**: `Lead`, `Team`, `User`

**Socket Events**: None

**Related Features**: Team Management (#7), User Management (#10), Reports (#13)

**Change Log**:
- Initial PDF export for teams
- Added user-scoped PDF export
