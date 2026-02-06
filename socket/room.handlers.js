const roomService = require("../storage/room.service");
const { getRoom, rooms } = require("./state");

function registerRoomHandlers(io, socket) {
  socket.on("room:create", async ({ name, userId }) => {
    try {
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

  socket.on("room:join", async ({ roomId, userId }) => {
    try {
      const member = await roomService.isMember(roomId, userId);
      const roomMeta = await roomService.getRoomWithMembers(roomId);

      if (!member) {
        socket.emit("room:error", {
          message: "Unauthorized",
        });
        return;
      }

      socket.userId = userId;
      socket.join(roomId);

      const room = await getRoom(roomId);

      room.presence.set(socket.id, {
        userId,
        name: userId.slice(0, 8),
        color: `#${Math.floor(Math.random() * 16777215).toString(16)}`,
        online: true,
        lastSeen: Date.now(),
      });

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

      socket.emit("fs:snapshot", {
        roomId,
        nodes: room.tree,
      });

      socket.emit("presence:update", {
        roomId,
        users: [...room.presence.values()],
      });

      socket.to(roomId).emit("presence:join", room.presence.get(socket.id));
    } catch (err) {
      console.error("Room join failed:", err);
      socket.emit("room:error", {
        message: "Room join failed",
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
