const { Server } = require("socket.io");
const registerRoomHandlers = require("./room.handlers");
const registerFsHandlers = require("./fs.handlers");
const registerYjsHandlers = require("./yjs.handlers");
const registerPresenceHandlers = require("./presence.handlers");
const { startRoomGC } = require("./state");

function initSocket(server) {
  const allowedOrigins = [
    "https://devsync-teal.vercel.app",
    "http://localhost:3000",
  ];

  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    console.log("Connected:", socket.id);

    registerRoomHandlers(io, socket);
    registerFsHandlers(io, socket);
    registerYjsHandlers(io, socket);
    registerPresenceHandlers(io, socket);
  });

  startRoomGC();
}

module.exports = { initSocket };
