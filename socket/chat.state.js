const MAX_ROOM_CHAT_MESSAGES = 200;

const roomChatHistory = new Map();

function getChatHistory(roomId) {
  return roomChatHistory.get(roomId) || [];
}

function appendChatMessage(roomId, message) {
  const existing = roomChatHistory.get(roomId) || [];
  const next = [...existing, message];
  roomChatHistory.set(
    roomId,
    next.length <= MAX_ROOM_CHAT_MESSAGES
      ? next
      : next.slice(next.length - MAX_ROOM_CHAT_MESSAGES)
  );
}

module.exports = {
  getChatHistory,
  appendChatMessage,
};

