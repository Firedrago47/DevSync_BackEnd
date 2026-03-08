const crypto = require("crypto");
const roomService = require("../storage/room.service");
const { appendChatMessage } = require("./chat.state");

const MAX_CHAT_MESSAGE_LENGTH = 2000;

function normalizeSenderName(value, fallbackId) {
  const name = typeof value === "string" ? value.trim() : "";
  if (name) return name;
  if (typeof fallbackId === "string" && fallbackId) {
    return fallbackId.slice(0, 8);
  }
  return "Anonymous";
}

function registerChatHandlers(io, socket) {
  socket.on("collab:message", async (payload) => {
    try {
      if (!payload || typeof payload !== "object") return;

      const roomId = typeof payload.roomId === "string" ? payload.roomId : "";
      if (!roomId) return;

      const member = await roomService.isMember(roomId, socket.userId);
      if (!member) {
        socket.emit("room:error", {
          roomId,
          code: "forbidden",
          message: "You are not allowed to send messages in this room",
        });
        return;
      }

      // Ensure sender is actually joined to this room socket channel.
      if (!socket.rooms.has(roomId)) return;

      const text =
        typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) return;

      const message = {
        id:
          typeof payload.id === "string" && payload.id
            ? payload.id
            : crypto.randomUUID(),
        roomId,
        channel: payload.channel === "mentor" ? "mentor" : "room",
        senderId: socket.userId,
        senderName: normalizeSenderName(payload.senderName, socket.userId),
        senderRole:
          payload.senderRole === "mentor" || payload.senderRole === "mentee"
            ? payload.senderRole
            : "member",
        text: text.slice(0, MAX_CHAT_MESSAGE_LENGTH),
        timestamp:
          typeof payload.timestamp === "number" &&
          Number.isFinite(payload.timestamp)
            ? payload.timestamp
            : Date.now(),
      };

      appendChatMessage(roomId, message);
      io.to(roomId).emit("collab:message", message);
    } catch (err) {
      console.error("collab:message failed:", err);
    }
  });
}

module.exports = registerChatHandlers;
