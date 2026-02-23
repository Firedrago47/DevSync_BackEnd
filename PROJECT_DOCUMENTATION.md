# DevSync: Interview Documentation

Last updated: February 23, 2026

## 1. Elevator Pitch
DevSync is a realtime collaborative coding platform where multiple users can:
- create/join rooms,
- edit a shared file tree,
- co-edit file content using Yjs CRDT,
- see collaborator presence,
- enforce owner-approved role access (`owner` / `editor` / `viewer`),
- run Python files through Piston and stream logs into the UI.

This repo (`DevSync_BackEnd`) is the backend.  
Frontend lives in `../devsync` (Next.js app).

## 2. Architecture Overview
```text
Frontend (Next.js + Socket.IO client + Zustand + Editor)
        |
        | HTTP + Socket.IO
        v
Backend (Express + Socket.IO + Yjs state manager)
        |
        | metadata
        v
Supabase Postgres (rooms, room_members)
        |
        | blobs
        v
Object Storage (Supabase bucket / local / s3)
  - rooms/<roomId>/tree.json
  - rooms/<roomId>/files/<fileId>.ydoc
```

## 3. Monorepo/Project Layout
```text
DevSync_BackEnd/
  app.js
  server.js
  routes/room.routes.js
  socket/
    index.js
    room.handlers.js
    fs.handlers.js
    yjs.handlers.js
    presence.handlers.js
    terminal.handlers.js
    state.js
  storage/
    index.js
    room.service.js
    supabase.db.js
    supabase.provider.js
    local.provider.js
    s3.provider.js

../devsync/
  app/
  features/collaboration/client/*
  features/filesystem/*
  features/editor/*
  features/terminal/*
  features/rooms/*
  ui/layout/*
```

## 4. Backend Lifecycle
1. `server.js` boots HTTP server and Socket.IO.
2. `socket/index.js` configures CORS and registers handlers.
3. Handlers split responsibilities:
- room access and approvals: `socket/room.handlers.js`
- file tree ops: `socket/fs.handlers.js`
- CRDT sync: `socket/yjs.handlers.js`
- awareness/presence: `socket/presence.handlers.js`
- code run logs: `socket/terminal.handlers.js`
4. In-memory runtime state is managed in `socket/state.js`.

## 5. Data Model
Current persistent model:
- `rooms`: `id`, `name`, `owner_id`
- `room_members`: `room_id`, `user_id`, `role`
- storage object keys:
  - `rooms/<roomId>/tree.json`
  - `rooms/<roomId>/files/<fileId>.ydoc`

Join requests are currently in-memory only (`pendingJoinRequests` map in `storage/room.service.js`), so they reset on backend restart.

## 6. Realtime Event Contract
### Room
Client -> Server:
- `room:create` `{ name, userId }`
- `room:join` `{ roomId, userId, name?, email? }`
- `room:leave` `{ roomId }`
- `room:assign-role` `{ roomId, userId, role: "viewer" | "editor" }`

Server -> Client:
- `room:created` `{ roomId }`
- `room:snapshot`
- `room:error` `{ roomId?, code?, message }`
- `room:join-request` `{ roomId, userId, name, email?, requestedAt }`

`room:snapshot` payload shape:
```json
{
  "roomId": "string",
  "room": { "id": "string", "name": "string", "ownerId": "string" },
  "members": [{ "userId": "string", "role": "owner|editor|viewer" }],
  "tree": []
}
```

Stable room error codes used:
- `pending_role_assignment`
- `forbidden`
- `room_not_found`

### File Tree
Client -> Server:
- `fs:create` `{ roomId, parentId?, name, type }`
- `fs:rename` `{ roomId, id, name }`
- `fs:delete` `{ roomId, id }`

Server -> Client:
- `fs:snapshot` `{ roomId, nodes }`
- `fs:create` `<node>`
- `fs:rename` `<node>`
- `fs:delete` `{ id }`

Note: broadcast payloads for `fs:create`/`fs:rename` currently do not include `roomId`.

### Yjs
Client -> Server:
- `yjs:join` `{ roomId, fileId }`
- `yjs:update` `{ roomId, fileId, update }`

Server -> Client:
- `yjs:sync` `{ roomId, fileId, update }`
- `yjs:update` `{ roomId, fileId, update }`

### Presence
Client -> Server:
- `awareness:update` `{ roomId, ... }`

Server -> Client:
- `presence:update` (full online list)
- `presence:join` (single user)
- `presence:leave` (single user)
- `awareness:update` (forwarded)

### Terminal (Piston-backed)
Client -> Server:
- `terminal:start` `{ roomId, fileId? }`
- `terminal:input` `{ roomId, input }`
- `terminal:stop` `{ roomId }`

Server -> Client:
- `terminal:session` `{ id, roomId, status }`
- `terminal:log` `{ id, timestamp, message, type }`

Important behavior:
- runs are non-interactive; `terminal:input` returns a system message saying stdin is not supported.

## 7. Core Flows
### A. Room Creation
1. Owner emits `room:create`.
2. Backend inserts room + owner membership.
3. Backend emits `room:created`.

### B. Join Approval Flow
1. User emits `room:join`.
2. If already in `room_members`, join is finalized immediately.
3. If not a member:
- backend stores pending request (in memory),
- emits `room:join-request` to owner sockets,
- emits `room:error` with `pending_role_assignment` to joiner.
4. Owner emits `room:assign-role`.
5. Backend upserts membership.
6. Backend emits updated `room:snapshot` to owner and assigned user.
7. Assigned user receives `fs:snapshot` + `presence:update`.

### C. Collaborative Files
1. Editor/owner mutates tree via `fs:*`.
2. Backend role-checks (`viewer` is blocked).
3. Updated tree is saved to `tree.json`.
4. Change is broadcast to room.

### D. Collaborative Editor (Yjs)
1. On file open, client emits `yjs:join`.
2. Backend sends `yjs:sync` with full state update.
3. Incremental edits are sent via `yjs:update`.
4. Backend applies updates and rebroadcasts.
5. Debounced persistence writes `.ydoc` updates to storage.

### E. Code Execution (Python)
1. User clicks run, frontend emits `terminal:start`.
2. Backend resolves target `.py` file from tree / selected file.
3. Backend posts source to Piston execute API.
4. Stdout/stderr/system logs stream to client as `terminal:log`.
5. UI shows logs in Terminal/Problems/Output tabs.

## 8. API Surface
HTTP:
- `GET /api/rooms/:roomId` -> room metadata + members

Example:
```json
{
  "id": "382b803f-6132-4008-9af8-a1286f37a79f",
  "name": "Interview Room",
  "ownerId": "user_123",
  "members": [
    { "userId": "user_123", "role": "owner" },
    { "userId": "user_456", "role": "editor" }
  ]
}
```

## 9. Environment Variables
### Backend (`DevSync_BackEnd/.env`)
Required for Supabase mode:
- `STORAGE_PROVIDER=supabase`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUCKET`

Networking:
- `PORT=6969`
- `CLIENT_ORIGIN` (production web origin(s), comma-separated allowed)
- `CLIENT_ORIGIN_DEV=http://localhost:3000`

Optional:
- `DEV_MODE=true` (uses in-memory rooms/members for development)
- `TERMINAL_TIMEOUT_MS=15000`
- `TERMINAL_MAX_LOG_CHARS=8000`
- `PISTON_URL=https://emkc.org/api/v2/piston/execute`
- `PISTON_PYTHON_VERSION=*`

### Frontend (`../devsync/.env.local`)
- `NEXT_PUBLIC_SOCKET_URL` or `NEXT_PUBLIC_WS_URL`
- `NEXT_PUBLIC_BACKEND_URL`
- auth-related vars (`NEXTAUTH_URL`, provider keys, etc.)

Socket target resolution priority:
1. `NEXT_PUBLIC_SOCKET_URL`
2. `NEXT_PUBLIC_WS_URL`
3. `NEXT_PUBLIC_BACKEND_URL`
4. `window.location.origin`

## 10. Local Setup
### Backend
```bash
cd /home/fire/Documents/Projects/DevSync_BackEnd
npm install
npm start
```

### Frontend
```bash
cd /home/fire/Documents/Projects/devsync
npm install
npm run dev
```

Open: `http://localhost:3000`

## 11. Common Issues and Fixes
### `xhr poll error` / `NetworkError when attempting to fetch resource`
- wrong frontend socket URL env,
- backend not reachable,
- backend CORS origins missing your frontend origin.

### Room joins but no collaboration
- check user membership row in `room_members`,
- verify both clients joined same `roomId`,
- ensure both clients opened same `fileId` for Yjs.

### Files not visible for second user
- confirm owner assigned role and backend emitted `room:snapshot`/`fs:snapshot`,
- verify client listeners are mounted (`room.hooks`, FS subscription).

### No run output
- confirm selected room has at least one `.py` file,
- check `terminal:log` events arrive in browser network/socket inspector,
- verify Piston endpoint is reachable from backend.

## 12. Security and Reliability Notes
Current strengths:
- role-gated file tree mutation,
- room membership checks for join/fs/terminal,
- server-side persisted tree and doc snapshots.

Current gaps to mention honestly in interview:
- socket auth trusts client-sent `userId` (no JWT verification middleware),
- pending join requests are non-persistent in-memory state,
- Yjs handlers currently do not enforce explicit membership checks.

## 13. Scalability Notes
- In-memory room/doc cache is efficient for single-node deployment.
- Room GC removes idle rooms from memory after inactivity.
- For horizontal scaling, you need:
  - sticky sessions,
  - shared adapter/state (e.g., Redis adapter),
  - distributed presence/session state.

## 14. Suggested Roadmap
1. Add socket auth middleware with JWT/session verification.
2. Persist pending join requests in Postgres.
3. Add membership checks in Yjs handlers.
4. Add integration tests for realtime contracts.
5. Add observability (structured logs, metrics, tracing).

## 15. Interview Demo Script (5 Minutes)
1. User A creates a room.
2. User B joins and gets pending approval state.
3. User A sees `room:join-request` and assigns `editor`.
4. User B appears in collaborators list and gets room snapshot.
5. User B creates/renames file; User A sees update.
6. Both open same file and type simultaneously; live Yjs sync is visible.
7. Run Python file and show logs in Output tab.
