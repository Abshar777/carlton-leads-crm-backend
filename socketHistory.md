# Carlton CRM — Socket.io & Web Push History

This file documents all real-time communication: Socket.io events, rooms, helper functions, and the Web Push (VAPID) notification system.

---

## Setup & Auth

**File**: `src/socket.ts`

### Initialization
`initSocket(httpServer)` is called in `src/index.ts` inside the `httpServer.listen()` callback:
```typescript
// src/index.ts
const httpServer = createServer(app);
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initSocket(httpServer);
  startReminderScheduler();
});
```

### Socket.IO Server Configuration
```typescript
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL,
    credentials: true
  }
});
```

### JWT Authentication Middleware
Applied to all socket connections before the connection event fires:
```typescript
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("No token"));

  try {
    const decoded = verifyAccessToken(token);
    socket.data.userId = decoded.userId;
    next();
  } catch (err) {
    next(new Error("Invalid token"));
  }
});
```
- Token is sent by the frontend in `socket.handshake.auth.token` (set when creating the Socket.io client)
- Calls `verifyAccessToken` from `utils/jwt.ts`
- Stores `userId` on `socket.data.userId` for use in connection handler

### Connection Handler
On every successful authenticated connection:
```typescript
io.on("connection", (socket) => {
  const userId = socket.data.userId;

  // Join private room for this user
  socket.join(`user:${userId}`);

  // Handle team room join/leave
  socket.on("join:team", (teamId: string) => {
    socket.join(`team:${teamId}`);
  });

  socket.on("leave:team", (teamId: string) => {
    socket.leave(`team:${teamId}`);
  });

  socket.on("disconnect", () => {
    // Rooms are automatically cleaned up on disconnect
  });
});
```

---

## Rooms

| Room | Format | Joined When | Left When |
|------|--------|-------------|-----------|
| User private room | `user:{userId}` | On connect (automatic) | On disconnect (automatic) |
| Team room | `team:{teamId}` | Client emits `join:team` with teamId | Client emits `leave:team` or disconnect |

### User Private Room
- Created automatically for every authenticated connection
- Used for direct, private notifications to a specific user
- Multiple browser tabs/devices for the same user all join the same room — all receive the notification

### Team Room
- Opt-in — client must emit `join:team` to join
- Frontend joins team room when navigating to a team's page
- Used for real-time team activity feed and chat

---

## Client → Server Events

Events the frontend sends TO the server:

| Event | Payload | Handler | Effect |
|-------|---------|---------|--------|
| `join:team` | `teamId: string` | Connection handler in `socket.ts` | Socket joins `team:{teamId}` room |
| `leave:team` | `teamId: string` | Connection handler in `socket.ts` | Socket leaves `team:{teamId}` room |

---

## Server → Client Events

Events the server emits TO clients. Frontend hooks that listen to each event are noted.

---

### `reminder:due`

| Property | Value |
|----------|-------|
| **Emitted by** | `reminderScheduler.ts` via `emitToUser()` |
| **When** | When a reminder's `remindAt` time passes (`remindAt <= now`) and `notifiedAt` is null |
| **Room** | User private room: `user:{userId}` (userId = `reminder.assignedTo`) |
| **Frontend listener** | `useReminderNotifications.ts` (React hook) |

**Payload shape**:
```typescript
{
  reminderId: string,   // reminder sub-document _id
  leadId: string,       // parent lead _id
  leadName: string,     // lead.name for display
  title: string,        // reminder.title
  body: string,         // reminder.body
  remindAt: string      // ISO UTC string
}
```

**Frontend behavior**: Shows a toast notification + adds to notification list in the navbar badge.

---

### `reminder:warning`

| Property | Value |
|----------|-------|
| **Emitted by** | `reminderScheduler.ts` via `emitToUser()` |
| **When** | When a reminder's `remindAt` is 1-31 minutes in the future and `warnedAt` is null |
| **Room** | User private room: `user:{userId}` |
| **Frontend listener** | `useReminderNotifications.ts` |

**Payload shape**:
```typescript
{
  reminderId: string,
  leadId: string,
  leadName: string,
  title: string,
  body: string,
  minsLeft: number,     // minutes until reminder fires (rounded)
  remindAt: string      // ISO UTC string
}
```

**Frontend behavior**: Shows a "reminder in X minutes" toast — less urgent than `reminder:due`.

---

### `team:update`

| Property | Value |
|----------|-------|
| **Emitted by** | `emitTeamUpdate()` helper in `socket.ts` — called from `teamService.ts` |
| **When** | When team activity feed updates (new message, lead status change within team) |
| **Room** | Team room: `team:{teamId}` |
| **Frontend listener** | `useTeamSocket` (custom hook in team detail page) |

**Payload shape**:
```typescript
{
  teamId: string,
  item: {
    type: "message" | "activity",
    // for type "message":
    senderId?: string,
    senderName?: string,
    content?: string,
    // for type "activity":
    action?: string,
    description?: string,
    leadId?: string,
    leadName?: string,
    timestamp: string
  }
}
```

**Frontend behavior**: React Query invalidates `["teams", teamId, "updates"]` and re-fetches. Also directly appends to optimistic UI list.

---

### `lead:assigned`

| Property | Value |
|----------|-------|
| **Emitted by** | `leadService.ts` → `assignLead()` and `teamService.ts` → `autoAssignTeamLeads()` via `emitToUser()` |
| **When** | When a lead is assigned to a user (manual assignment or auto-assign) |
| **Room** | User private room: `user:{userId}` (userId = the assignee) |
| **Frontend listener** | `useLeadSocket` or notification hook — shows "New lead assigned" toast |

**Payload shape**:
```typescript
{
  leadId: string,
  leadName: string,
  assignedBy: string    // userId of the person who triggered assignment
}
```

**Frontend behavior**: Toast notification — "Lead [name] has been assigned to you". React Query invalidates `["leads"]`.

---

## Helper Functions

All exported from `src/socket.ts`:

### `initSocket(httpServer: HttpServer): void`
- Initializes the Socket.IO server
- Registers JWT auth middleware
- Registers connection handler (private room join + team room join/leave)
- Stores the `io` instance in a module-level variable for `getIO()` access

### `getIO(): Server`
- Returns the singleton Socket.IO `Server` instance
- Throws `Error("Socket.io not initialized")` if called before `initSocket()`
- Used by services that need to emit events directly

### `emitToUser(userId: string, event: string, payload: unknown): void`
- Convenience wrapper: `getIO().to(`user:${userId}`).emit(event, payload)`
- Used by: `leadService.ts`, `teamService.ts`, `reminderScheduler.ts`
- Does NOT throw if user is offline — Socket.io silently drops the event if the room has no listeners

### `emitTeamUpdate(teamId: string, item: TeamUpdateItem): void`
- Emits `team:update` event to `team:{teamId}` room
- Payload: `{ teamId, item }`
- Used by: `teamService.postTeamMessage()`

---

## Web Push (VAPID)

Web Push is the other notification path alongside Socket.io. Used when the user's browser tab is closed or in the background.

**File**: `src/services/pushService.ts`
**Model**: `PushSubscription` — stores browser push subscriptions per user

### PushSubscription Schema
```typescript
{
  userId: ObjectId,      // ref: User
  endpoint: string,      // browser push endpoint URL (unique index)
  keys: {
    p256dh: string,      // Diffie-Hellman key
    auth: string         // Auth secret
  },
  createdAt: Date
}
```

### VAPID Configuration
```typescript
webpush.setVapidDetails(
  'mailto:admin@carltoncrm.com',
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
);
```

### `sendPushToUser(userId, notification)`
**Signature**: `sendPushToUser(userId: string, notification: PushNotification): Promise<{ sent: number, failed: number }>`

**Notification shape**:
```typescript
{
  title: string,
  body: string,
  tag?: string,       // for deduplication (same tag = replace previous notification)
  url?: string,       // URL to open when notification is clicked
  data?: object       // additional data passed to service worker
}
```

**Implementation**:
1. Fetch all `PushSubscription` documents for `userId`
2. For each subscription: call `webpush.sendNotification(sub, JSON.stringify(notification))`
3. If response is 410 (Gone) → subscription expired → delete the document
4. Count `sent` and `failed` — return both

### `notifyLeadAssignment(userId, leadId, leadName, assignedBy)`
Convenience wrapper:
```typescript
await sendPushToUser(userId, {
  title: "New Lead Assigned",
  body: `${leadName} has been assigned to you`,
  tag: `lead-assign-${leadId}`,
  url: `/leads/${leadId}`
});
```

### `notifyBulkLeadAssignment(userId, count)`
Convenience wrapper:
```typescript
await sendPushToUser(userId, {
  title: `${count} Leads Assigned`,
  body: `${count} new leads have been assigned to you`,
  tag: "bulk-lead-assign"
});
```

### Push Routes
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/push/vapid-public-key` | `authenticate` |
| POST | `/api/v1/push/subscribe` | `authenticate` |
| DELETE | `/api/v1/push/unsubscribe` | `authenticate` |

**Subscribe body**:
```typescript
{
  endpoint: string,
  keys: { p256dh: string, auth: string }
}
```
(This is the standard PushSubscription object from `navigator.serviceWorker.pushManager.subscribe()`)

---

## Reminder Notification Full Flow

The complete path from background scheduler to browser notification:

```
[Server — every 30s]
reminderScheduler.tick()
  │
  ├─ Queries Lead collection for due reminders ($elemMatch)
  │
  ├─ For each due reminder:
  │   ├─ emitToUser(reminder.assignedTo, "reminder:due", payload)
  │   │   └─ socket.ts → getIO().to("user:{userId}").emit(...)
  │   │       └─ [If browser tab OPEN] → Socket.io delivers to frontend
  │   │           └─ useReminderNotifications hook → shows toast
  │   │
  │   ├─ sendPushToUser(reminder.assignedTo, { title, body, ... })
  │   │   └─ pushService.ts → webpush.sendNotification(subscription, ...)
  │   │       └─ [If browser tab CLOSED/BACKGROUND] → Browser Push API delivers
  │   │           └─ Service Worker → shows OS-level notification
  │   │
  │   └─ Stamps reminder.notifiedAt = now (prevents re-firing)
  │       └─ Lead.updateOne with arrayFilters: [{ "r._id": reminderId }]
  │
  └─ For each warning reminder (1-31min ahead):
      ├─ emitToUser(..., "reminder:warning", { minsLeft, ... })
      └─ Stamps reminder.warnedAt = now
```

### Dual Delivery Strategy
- **Socket.io** — delivers instantly when user has the app open. Zero latency. Falls silently if user is offline.
- **Web Push** — delivers via the browser's push infrastructure even when the app is closed. Slightly delayed. Requires user to grant notification permission.

Both fire for the same reminder — the frontend is expected to deduplicate by `reminderId` (e.g., if the socket reminder arrives first, the push notification that arrives shortly after should not cause a double-toast).
