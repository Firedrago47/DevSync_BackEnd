const { Server } = require("socket.io");
const registerRoomHandlers = require("./room.handlers");
const registerFsHandlers = require("./fs.handlers");
const registerYjsHandlers = require("./yjs.handlers");
const registerPresenceHandlers = require("./presence.handlers");
const registerTerminalHandlers = require("./terminal.handlers");
const { startRoomGC } = require("./state");

function getAllowedOrigins() {
  const raw = [
    process.env.CLIENT_ORIGIN,
    process.env.CLIENT_ORIGIN_DEV,
  ]
    .filter(Boolean)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  if (raw.length === 0) {
    return ["http://localhost:3000"];
  }

  return [...new Set(raw)];
}

function initSocket(server) {
  const allowedOrigins = getAllowedOrigins();
  const io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log("Connected:", socket.id);

    registerRoomHandlers(io, socket);
    registerFsHandlers(io, socket);
    registerYjsHandlers(io, socket);
    registerPresenceHandlers(io, socket);
    registerTerminalHandlers(io, socket);
  });

  startRoomGC();
}

module.exports = { initSocket };
