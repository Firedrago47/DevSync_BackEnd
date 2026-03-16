# DevSync Backend

DevSync is a collaborative coding platform built for learning and mentoring in open-source contribution workflows.
This backend powers rooms, permissions, realtime sync, and remote code execution.

## Why this project exists

Most new contributors struggle with open-source onboarding because the workflow is fragmented:
- one tool for chat,
- another for docs,
- another for editing,
- another for running code.

DevSync brings those steps into one shared workspace so mentors and contributors can learn and collaborate together in context.

## Project purpose

This platform is intentionally focused on **education and mentoring**, not CI/CD deployment.

It helps contributors:
- understand unfamiliar codebases faster,
- collaborate safely with role-based access,
- get real-time guidance from mentors,
- practice contribution flow in a portable environment.

## Practical use cases

- Contributor onboarding sessions for FOSS communities
- Guided “first issue” workshops
- Realtime pair debugging and code walkthroughs
- Architecture explanation sessions for complex projects
- Classroom/cohort style collaborative labs

## How we built it (abstract view)

Backend stack:
- Node.js + Express
- Socket.IO for realtime communication
- Yjs for conflict-resistant collaborative editing
- Supabase/Postgres for room + membership metadata
- Pluggable storage for file trees and ydoc snapshots
- Judge0 for remote code execution output

Core design decisions:
- Separate event handlers by responsibility (`room`, `fs`, `yjs`, `presence`, `chat`, `voice`, `terminal`)
- Keep frontend contract stable and push state through explicit socket events
- Persist critical room data (tree/ydoc), keep fast collaborative state in memory
- Enforce role checks at mutation points

## Realtime features handled by backend

- Room create/join/leave with owner approval workflow
- File tree create/rename/delete sync
- Yjs document sync and updates
- Presence + awareness updates
- In-room chat
- Voice signaling (WebRTC signaling layer)
- Terminal execution logs via Judge0
- Repository import into a room (clone + tree generation)


## Environment highlights

Set these in `.env`:
- `PORT`
- `CLIENT_ORIGIN`, `CLIENT_ORIGIN_DEV`
- Supabase/storage variables (if not in DEV_MODE)
- Judge0 variables (`JUDGE0_BASE_URL`, optional auth headers)

## API / contract details

For full event payload contracts and architecture details, see:
- `PROJECT_DOCUMENTATION.md`
