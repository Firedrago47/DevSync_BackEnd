const { Server } = require("socket.io");
const registerRoomHandlers = require("./room.handlers");
const registerFsHandlers = require("./fs.handlers");
const registerYjsHandlers = require("./yjs.handlers");
const registerPresenceHandlers = require("./presence.handlers");
const { startRoomGC } = require("./state");

function initSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_ORIGIN || "http://localhost:3000",
      methods: ["GET", "POST"],
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
