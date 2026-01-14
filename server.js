const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN, 
    methods: ["GET", "POST"],
  },
});

const rooms = new Map(); 

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("room:join", ({ roomId, user }) => {
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, { code: "" });
    }

    socket.to(roomId).emit("presence:join", user);
    socket.emit("file:init", rooms.get(roomId).code);
  });

  socket.on("file:update", ({ roomId, content }) => {
    if (!rooms.has(roomId)) return;

    rooms.get(roomId).code = content;
    socket.to(roomId).emit("file:update", content);
  });

  socket.on("cursor:update", ({ roomId, cursor }) => {
    socket.to(roomId).emit("cursor:update", cursor);
  });

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      socket.to(roomId).emit("presence:leave", socket.id);
    }
  });
});

server.listen(process.env.PORT || 6969, () =>
  console.log("Realtime server running")
);
