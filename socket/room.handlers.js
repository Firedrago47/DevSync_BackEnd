const roomService = require("../storage/room.service");
const { getRoom, rooms } = require("./state");

const ALLOWED_ASSIGNABLE_ROLES = new Set(["viewer", "editor"]);

function getUserSockets(io, userId) {
  const sockets = [];
  for (const connectedSocket of io.sockets.sockets.values()) {
    if (connectedSocket.userId === userId) {
      sockets.push(connectedSocket);
    }
  }
  return sockets;
}

async function emitRoomSnapshot(socket, roomId) {
  const roomMeta = await roomService.getRoomWithMembers(roomId);
  if (!roomMeta) return;

  const room = await getRoom(roomId);
  socket.emit("room:snapshot", {
    roomId,
    room: {
      id: roomMeta.id,
      name: roomMeta.name,
      ownerId: roomMeta.ownerId,
    },
    members: roomMeta.members,
    tree: room.tree,
  });
}

function buildPresenceUser(userId, name) {
  return {
    userId,
    name: name || userId.slice(0, 8),
    color: `#${Math.floor(Math.random() * 16777215).toString(16)}`,
    online: true,
    lastSeen: Date.now(),
  };
}

async function finalizeRoomJoin(socket, roomId, userId, name) {
  socket.userId = userId;
  socket.join(roomId);
  await roomService.clearPendingJoinRequest(roomId, userId);

  const room = await getRoom(roomId);
  room.presence.set(socket.id, buildPresenceUser(userId, name));

  await emitRoomSnapshot(socket, roomId);

  socket.emit("fs:snapshot", {
    roomId,
    nodes: room.tree,
  });

  socket.emit("presence:update", {
    roomId,
    users: [...room.presence.values()],
  });

  socket.to(roomId).emit("presence:join", room.presence.get(socket.id));
}

function registerRoomHandlers(io, socket) {
  socket.on("room:create", async ({ name, userId }) => {
    try {
      socket.userId = userId;
      const { roomId } = await roomService.createRoom({
        name,
        ownerId: userId,
      });

      socket.emit("room:created", { roomId });
    } catch (err) {
      console.error("Room creation failed:", err);
      socket.emit("room:error", {
        message: "Room creation failed",
      });
    }
  });

  socket.on("room:join", async ({ roomId, userId, name, email }) => {
    try {
      const roomMeta = await roomService.getRoomWithMembers(roomId);
      if (!roomMeta) {
        socket.emit("room:error", {
          roomId,
          code: "room_not_found",
          message: "Room not found",
        });
        return;
      }

      socket.userId = userId;
      const member = await roomService.isMember(roomId, userId);

      if (!member) {
        const request = await roomService.upsertPendingJoinRequest({
          roomId,
          userId,
          name,
          email,
          requestedAt: Date.now(),
        });

        const ownerSockets = getUserSockets(io, roomMeta.ownerId);
        for (const ownerSocket of ownerSockets) {
          ownerSocket.emit("room:join-request", request);
        }

        socket.emit("room:error", {
          roomId,
          code: "pending_role_assignment",
          message: "Waiting for room owner to assign your role",
        });
        return;
      }

      await finalizeRoomJoin(socket, roomId, userId, name);
    } catch (err) {
      console.error("Room join failed:", err);
      socket.emit("room:error", {
        roomId,
        message: "Room join failed",
      });
    }
  });

  socket.on("room:assign-role", async ({ roomId, userId, role }) => {
    try {
      if (!socket.userId) {
        socket.emit("room:error", {
          roomId,
          code: "forbidden",
          message: "Unauthorized",
        });
        return;
      }

      if (!ALLOWED_ASSIGNABLE_ROLES.has(role)) {
        socket.emit("room:error", {
          roomId,
          code: "forbidden",
          message: "Invalid role",
        });
        return;
      }

      const roomMeta = await roomService.getRoomWithMembers(roomId);
      if (!roomMeta) {
        socket.emit("room:error", {
          roomId,
          code: "room_not_found",
          message: "Room not found",
        });
        return;
      }

      if (roomMeta.ownerId !== socket.userId) {
        socket.emit("room:error", {
          roomId,
          code: "forbidden",
          message: "Only the owner can assign roles",
        });
        return;
      }

      await roomService.assignRole({ roomId, userId, role });

      const pendingRequest = await roomService.getPendingJoinRequest(roomId, userId);

      const ownerSockets = getUserSockets(io, roomMeta.ownerId);
      for (const ownerSocket of ownerSockets) {
        await emitRoomSnapshot(ownerSocket, roomId);
      }

      const targetSockets = getUserSockets(io, userId);
      for (const targetSocket of targetSockets) {
        await finalizeRoomJoin(
          targetSocket,
          roomId,
          userId,
          pendingRequest?.name
        );
      }
    } catch (err) {
      console.error("Room role assignment failed:", err);
      socket.emit("room:error", {
        roomId,
        message: "Room role assignment failed",
      });
    }
  });

  socket.on("room:leave", ({ roomId }) => {
    socket.leave(roomId);

    const room = rooms.get(roomId);
    if (!room) return;

    room.presence.delete(socket.id);
    io.to(roomId).emit("presence:leave", {
      userId: socket.userId,
    });
  });
}

module.exports = registerRoomHandlers;
