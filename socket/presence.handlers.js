const { rooms } = require("./state");

function registerPresenceHandlers(io, socket) {
  socket.on("awareness:update", (payload) => {
    socket.to(payload.roomId).emit("awareness:update", payload);
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      const presence = room.presence.get(socket.id);
      if (presence) {
        room.presence.delete(socket.id);
        io.to(roomId).emit("presence:leave", {
          userId: presence.userId,
        });
      }
    }
  });
}

module.exports = registerPresenceHandlers;
