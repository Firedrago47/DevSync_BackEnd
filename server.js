const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
require("dotenv").config();

const storage = require("./storage");

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

/**
 * In-memory room cache (authoritative state is S3)
 * Used only for fast access during active sessions
 */
const rooms = new Map();

/* Helpers */

async function loadTree(roomId) {
  try {
    const raw = await storage.getObject(
      `rooms/${roomId}/tree.json`
    );
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveTree(roomId, tree) {
  await storage.putObject(
    `rooms/${roomId}/tree.json`,
    JSON.stringify(tree),
    "application/json"
  );
}

async function saveFile(roomId, path, content) {
  await storage.putObject(
    `rooms/${roomId}/files/${path}`,
    content,
    "text/plain"
  );
}

/* Socket.IO */


io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  /* -------- Room Join -------- */

  socket.on("room:join", async ({ roomId, user }) => {
    socket.join(roomId);

    // Load filesystem snapshot
    const tree = await loadTree(roomId);

    // Initialize room cache
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        tree,
      });
    }

    socket.emit("fs:snapshot", tree);
    socket.to(roomId).emit("presence:join", user);
  });

  /* -------- Editor Sync -------- */

  socket.on(
    "file:update",
    async ({ roomId, fileId, content, version, clientId }) => {
      socket.to(roomId).emit("file:update", {
        fileId,
        content,
        version,
        clientId,
      });

      // Persist file
      const room = rooms.get(roomId);
      const node = room?.tree.find((n) => n.id === fileId);

      if (node?.path) {
        await saveFile(roomId, node.path, content);
      }
    }
  );

  /* -------- Filesystem Sync -------- */

  socket.on("fs:create", async ({ roomId, node }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.tree.push(node);
    await saveTree(roomId, room.tree);

    socket.to(roomId).emit("fs:create", node);
  });

  socket.on("fs:rename", async ({ roomId, id, name }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const node = room.tree.find((n) => n.id === id);
    if (!node) return;

    node.name = name;
    await saveTree(roomId, room.tree);

    socket.to(roomId).emit("fs:rename", { id, name });
  });

  socket.on("fs:delete", async ({ roomId, id }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.tree = room.tree.filter((n) => n.id !== id);
    await saveTree(roomId, room.tree);

    socket.to(roomId).emit("fs:delete", { id });
  });

  /* -------- Cursor Sync -------- */

  socket.on("cursor:update", ({ roomId, cursor }) => {
    socket.to(roomId).emit("cursor:update", cursor);
  });

  /* -------- Disconnect -------- */

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      socket.to(roomId).emit("presence:leave", socket.id);
    }
  });
});

/* Start Server */

const PORT = process.env.PORT || 6969;
server.listen(PORT, () => {
  console.log(`Realtime server running on port ${PORT}`);
});
