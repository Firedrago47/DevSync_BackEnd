# DevSync Platform Documentation

Last updated: March 10, 2026

## 1. What DevSync Is
DevSync is a realtime collaborative coding platform.

Core capabilities:
- Room creation and role-based access (`owner`, `editor`, `viewer`)
- Owner approval flow for new joiners
- Shared file tree (create/rename/delete)
- Realtime co-editing with Yjs CRDT
- Presence and awareness updates
- Room chat
- Voice signaling for WebRTC calling
- Code execution through Judge0 (multi-language)

Codebase split:
- Backend: `DevSync_BackEnd` (this repo)
- Frontend: `../devsync` (Next.js)

---

## 2. High-Level Architecture

```text
Frontend (Next.js, Zustand, Monaco, Socket.IO client)
            |
            | HTTP + Socket.IO
            v
Backend (Express + Socket.IO + Yjs runtime)
            |
            | metadata
            v
Supabase Postgres (rooms, room_members)
            |
            | file tree + ydoc blobs
            v
Storage Provider (Supabase bucket / local / S3)
  - rooms/<roomId>/tree.json
  - rooms/<roomId>/files/<fileId>.ydoc
```

Execution engine:
- Backend submits code to Judge0 API and streams logs to frontend terminal UI.

---

## 3. Backend Folder Layout

```text
DevSync_BackEnd/
  app.js
  server.js
  routes/
    room.routes.js
  socket/
    index.js
    state.js
    room.handlers.js
    fs.handlers.js
    yjs.handlers.js
    presence.handlers.js
    chat.handlers.js
    chat.state.js
    voice.handlers.js
    terminal.handlers.js
  storage/
    index.js
    room.service.js
    supabase.db.js
    supabase.provider.js
    local.provider.js
    s3.provider.js
```

Key runtime state:
- `socket/state.js`: room in-memory runtime, Yjs docs, presence maps
- `socket/chat.state.js`: in-memory chat history per room
- `storage/room.service.js`: room/membership persistence + pending join requests map

---

## 4. Data Model

Persistent tables:
- `rooms`: `id`, `name`, `owner_id`
- `room_members`: `room_id`, `user_id`, `role`

Storage objects:
- `rooms/<roomId>/tree.json`
- `rooms/<roomId>/files/<fileId>.ydoc`

Current non-persistent data:
- pending join requests (in-memory map)
- in-memory voice peer state
- in-memory chat history

---

## 5. Socket Event Contract (Current)

### 5.1 Room
Client -> Server:
- `room:create` `{ name, userId }`
- `room:join` `{ roomId, userId, name?, email? }`
- `room:leave` `{ roomId }`
- `room:assign-role` `{ roomId, userId, role: "viewer" | "editor" }`

Server -> Client:
- `room:created` `{ roomId }`
- `room:snapshot` `{ roomId, room, members, tree }`
- `room:error` `{ roomId?, code?, message }`
- `room:join-request` `{ roomId, userId, name, email?, requestedAt }`

Stable `room:error.code` values:
- `pending_role_assignment`
- `forbidden`
- `room_not_found`

### 5.2 File Tree
Client -> Server:
- `fs:create` `{ roomId, parentId, name, type }`
- `fs:rename` `{ roomId, id, name }`
- `fs:delete` `{ roomId, id }`

Server -> Client:
- `fs:snapshot` `{ roomId, nodes }`
- `fs:create` `<node>`
- `fs:rename` `<node>`
- `fs:delete` `{ id }`

### 5.3 Yjs
Client -> Server:
- `yjs:join` `{ roomId, fileId }`
- `yjs:update` `{ roomId, fileId, update }`

Server -> Client:
- `yjs:sync` `{ roomId, fileId, update }`
- `yjs:update` `{ roomId, fileId, update }`

### 5.4 Presence + Awareness
Client -> Server:
- `awareness:update` `{ roomId, ... }`

Server -> Client:
- `presence:update` (full list)
- `presence:join` (single user)
- `presence:leave` (single user)
- `awareness:update` (forwarded)

### 5.5 Chat
Client -> Server:
- `collab:message` `{ roomId, channel, text, senderName, ... }`

Server -> Client:
- `collab:message` `<message>`
- `collab:history` `{ roomId, messages }` (on join)

### 5.6 Voice Signaling (WebRTC signaling only)
Client -> Server:
- `webrtc:join` `{ roomId, name?, muted? }`
- `webrtc:leave` `{ roomId }`
- `webrtc:mute` `{ roomId, muted }`
- `webrtc:offer` `{ roomId, targetSocketId, sdp }`
- `webrtc:answer` `{ roomId, targetSocketId, sdp }`
- `webrtc:ice-candidate` `{ roomId, targetSocketId, candidate }`

Server -> Client:
- `webrtc:peers` `{ roomId, peers[] }`
- `webrtc:peer-joined` `{ roomId, peer }`
- `webrtc:peer-updated` `{ roomId, peer }`
- `webrtc:peer-left` `{ roomId, socketId, userId }`
- `webrtc:offer` `{ roomId, fromSocketId, sdp }`
- `webrtc:answer` `{ roomId, fromSocketId, sdp }`
- `webrtc:ice-candidate` `{ roomId, fromSocketId, candidate }`

### 5.7 Terminal
Client -> Server:
- `terminal:start` `{ roomId, fileId? }`
- `terminal:input` `{ roomId, input }` (currently non-interactive)
- `terminal:stop` `{ roomId }`

Server -> Client:
- `terminal:session` `{ id, roomId, status }`
- `terminal:log` `{ id, timestamp, message, type }`

---

## 6. Core Runtime Flows

### 6.1 Room Join Approval
1. User emits `room:join`.
2. Backend checks `room_members`.
3. If not a member:
   - stores pending request (in-memory)
   - emits `room:join-request` to owner sockets
   - emits `room:error` with `pending_role_assignment` to joiner
4. Owner emits `room:assign-role`.
5. Backend upserts membership.
6. Backend finalizes join and emits `room:snapshot`, `fs:snapshot`, `presence:update`, `collab:history`.

### 6.2 Realtime Editing
1. Client opens file -> `yjs:join`.
2. Backend returns current document with `yjs:sync`.
3. Edits stream via `yjs:update`.
4. Backend rebroadcasts updates and persists document snapshots.

### 6.3 Judge0 Execution
1. User clicks run -> `terminal:start` with selected `fileId`.
2. Backend resolves runnable file by extension.
3. Backend maps extension to Judge0 `language_id`.
4. Backend submits code to Judge0 and polls until finished.
5. Backend emits stdout/stderr/system lines through `terminal:log`.

Supported extensions (default mapping):
- `.py` -> 71
- `.js` -> 63
- `.ts` -> 74
- `.c` -> 50
- `.cpp`, `.cc`, `.cxx` -> 54
- `.java` -> 62
- `.go` -> 60
- `.rs` -> 73

---

## 7. Environment Variables

## 7.1 Backend (`DevSync_BackEnd/.env`)
Core:
- `PORT=6969`
- `CLIENT_ORIGIN`
- `CLIENT_ORIGIN_DEV=http://localhost:3000`

Storage/Supabase mode:
- `STORAGE_PROVIDER=supabase`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUCKET`

Dev mode (optional):
- `DEV_MODE=true`

Terminal/Judge0:
- `TERMINAL_TIMEOUT_MS=15000`
- `TERMINAL_MAX_LOG_CHARS=8000`
- `JUDGE0_BASE_URL`
- `JUDGE0_POLL_INTERVAL_MS=750`
- `JUDGE0_WAIT_MODE=false`
- `JUDGE0_API_KEY` (if required by your Judge0 host)
- `JUDGE0_API_KEY_HEADER` (default `X-RapidAPI-Key`)
- `JUDGE0_HOST` (optional)
- `JUDGE0_HOST_HEADER` (default `X-RapidAPI-Host`)

Optional language-id overrides:
- `JUDGE0_LANGUAGE_ID_PY`
- `JUDGE0_LANGUAGE_ID_JS`
- `JUDGE0_LANGUAGE_ID_TS`
- `JUDGE0_LANGUAGE_ID_C`
- `JUDGE0_LANGUAGE_ID_CPP`
- `JUDGE0_LANGUAGE_ID_JAVA`
- `JUDGE0_LANGUAGE_ID_GO`
- `JUDGE0_LANGUAGE_ID_RS`

## 7.2 Frontend (`../devsync/.env.local`)
- `NEXT_PUBLIC_BACKEND_URL`
- NextAuth/provider vars (`NEXTAUTH_URL`, provider keys, etc.)

---

## 8. Local Development Setup

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

Open `http://localhost:3000`.

---

## 9. Deployment Model

Recommended split:
- Frontend: Vercel
- Backend: Railway
- Judge0: self-hosted (Railway or dedicated host) or managed endpoint
- Storage/DB: Supabase

Important production notes:
- Ensure backend CORS includes your frontend domain(s).
- Ensure backend can reach Judge0 URL.
- Use server-side secrets only (never expose Judge0 keys to frontend).

---

## 10. Security Notes

Current strengths:
- Membership checks on room join, fs operations, terminal execution, chat
- Owner-only role assignment flow

Known gaps / improvements:
- Socket auth still relies on client-provided identity in some paths (add strict server auth middleware)
- Pending join requests are in-memory only (persist in DB)
- Chat/voice histories are memory-scoped (no durable history)

---

## 11. Troubleshooting

### Room stuck or join hangs
- Verify backend reachable from frontend URL
- Verify room exists and user has membership (or owner approved)

### `room:error` with `pending_role_assignment`
- Expected until owner assigns `viewer`/`editor`

### Terminal shows no output
- Verify selected file extension is supported
- Verify Judge0 URL/credentials
- Check backend logs for Judge0 HTTP errors

### Judge0 `401 Invalid API key`
- Wrong/missing Judge0 key header for provider
- If self-hosted Judge0, usually no RapidAPI headers are needed

### Voice issues
- WebRTC needs network-compatible STUN/TURN setup for broad NAT cases
- Current implementation is signaling + P2P; large rooms require SFU architecture

---

## 12. Interview Demo Script (5–7 min)
1. Create room as User A.
2. Join as User B -> show pending approval state.
3. Approve User B as editor from User A.
4. Show both users in collaboration/presence.
5. Create/rename files and show realtime sync.
6. Open same file in both clients and co-edit live.
7. Run code from terminal and show Judge0-backed output.
8. Send chat message and show realtime delivery.
9. Open voice dock and show signaling join/mute/leave behavior.

---

## 13. Current Platform Summary
DevSync currently delivers a complete collaborative coding baseline:
- role-gated room access
- shared filesystem + CRDT editing
- presence/chat/voice signaling
- multi-language cloud execution through Judge0

Next milestone should focus on production hardening:
- strict socket auth
- persistent pending requests/history
- scalable voice architecture (TURN/SFU)
- deeper observability and e2e tests.

Problem Statement:

Open-source contributors, especially students and first-time contributors, struggle to collaborate in real time across fragmented tools (chat apps, code editors, docs, and review systems). This slows learning, increases onboarding friction, and makes mentor-guided contribution sessions hard to run.

This platform solves that by providing a single educational collaboration workspace where contributors can:

create/join project rooms with role-based access,
request approval and receive guided onboarding by room owners/mentors,
co-edit code in real time with presence awareness,
communicate through chat and voice in context,
run and validate code directly in the shared environment.

In short: it reduces coordination overhead and enables structured, mentor-friendly, real-time open-source contribution learning.

Use Cases (Educational / Mentoring Focus)

Guided OSS Onboarding Sessions
Mentor creates a room, admits contributors, assigns viewer/editor, and walks through project structure and contribution workflow live.

Collaborative Codebase Reading
Small groups open the same files, annotate/discuss logic in real time, and build shared understanding of unfamiliar FOSS codebases.

Mentored Bug Reproduction Practice
Contributor runs sample code in the shared environment, posts output, and gets immediate mentor feedback on debugging steps.

PR Preparation Workshops
Teams draft and refine contribution changes collaboratively before opening a real PR in upstream repositories.

Pair/Mob Learning for First-Time Contributors
Multiple learners co-edit while mentor supervises, correcting misconceptions early and explaining standards.

Role-Based Review Simulations
Owner sets some users as viewer (review role) and others as editor (implementation role) to simulate real contribution dynamics.

Live Code Review Training
Mentor reviews contributor edits line-by-line, explains design tradeoffs, and demonstrates clean patching patterns.

Contributor Communication Drills
In-room chat + voice are used for structured technical discussion, async notes, and review decisions during learning sessions.

Portable Classroom/Lab Environment
No complex local setup per learner; participants join the same room and focus on learning/contributing rather than environment issues.

Community Cohort Programs
Open-source communities run weekly cohorts where maintainers mentor newcomers in a repeatable, shared collaboration workflow.

Positioning Statement
This platform is for education and mentorship in open-source contribution. It is not currently a build/deploy CI platform; it is a guided collaborative workspace for understanding codebases, practicing contributions, and receiving mentor support.