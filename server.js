/* ===============================
   server.js — DevSync Realtime Server
   Protocol-aligned with frontend
=============================== */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { randomUUID } = require("crypto");
require("dotenv").config();

const storage = require("./storage");

/* ---------------- Setup ---------------- */

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
 * In-memory active room cache
 * Authoritative persistence = storage (S3)
 *
 * rooms = Map<roomId, {
 *   tree: FSNode[],
 *   files: Map<fileId, { content, revision }>
 * }>
 */
const rooms = new Map();

/* ---------------- Storage helpers ---------------- */

async function loadTree(roomId) {
  try {
    const raw = await storage.getObject(`rooms/${roomId}/tree.json`);
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

async function loadFile(roomId, path) {
  try {
    return await storage.getObject(`rooms/${roomId}/files/${path}`);
  } catch {
    return "";
  }
}

async function saveFile(roomId, path, content) {
  await storage.putObject(
    `rooms/${roomId}/files/${path}`,
    content,
    "text/plain"
  );
}

/* ---------------- Utility ---------------- */

function computePath(tree, parentId, name) {
  if (!parentId) return name;
  const parent = tree.find((n) => n.id === parentId);
  return parent ? `${parent.path}/${name}` : name;
}

function deleteSubtree(tree, id) {
  const toDelete = new Set([id]);

  for (const node of tree) {
    if (toDelete.has(node.parentId)) {
      toDelete.add(node.id);
    }
  }

  return tree.filter((n) => !toDelete.has(n.id));
}

/* ---------------- Socket.IO ---------------- */

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  /* -------- Room Join -------- */

  socket.on("room:join", async ({ roomId, userId }) => {
    socket.join(roomId);

    let room = rooms.get(roomId);
    if (!room) {
      const tree = await loadTree(roomId);
      room = {
        tree,
        files: new Map(),
      };
      rooms.set(roomId, room);
    }

    /* --- Send filesystem snapshot --- */
    socket.emit("fs:snapshot", {
      roomId,
      nodes: room.tree,
    });

    /* --- Send presence snapshot (simple) --- */
    io.to(roomId).emit("presence:update", {
      roomId,
      users: Array.from(io.sockets.adapter.rooms.get(roomId) || []).map(
        (id) => ({
          userId: id,
          name: id.slice(0, 6),
          color: "#4f46e5",
          online: true,
          lastSeen: Date.now(),
        })
      ),
    });
  });

  /* -------- Filesystem -------- */

  socket.on("fs:create", async ({ roomId, parentId, name, type }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const id = randomUUID();
    const path = computePath(room.tree, parentId, name);

    const node = {
      id,
      name,
      type,
      parentId: parentId ?? null,
      path,
      updatedAt: Date.now(),
    };

    room.tree.push(node);
    await saveTree(roomId, room.tree);

    io.to(roomId).emit("fs:create", node);
  });

  socket.on("fs:rename", async ({ roomId, id, name }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const node = room.tree.find((n) => n.id === id);
    if (!node) return;

    node.name = name;
    node.path = computePath(room.tree, node.parentId, name);
    node.updatedAt = Date.now();

    await saveTree(roomId, room.tree);
    io.to(roomId).emit("fs:rename", node);
  });

  socket.on("fs:delete", async ({ roomId, id }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.tree = deleteSubtree(room.tree, id);
    await saveTree(roomId, room.tree);

    io.to(roomId).emit("fs:delete", { id });
  });

  /* -------- Editor -------- */

  socket.on(
    "file:update",
    async ({ roomId, fileId, content, baseRevision }) => {
      const room = rooms.get(roomId);
      if (!room) return;

      const file =
        room.files.get(fileId) || { content: "", revision: 0 };

      if (baseRevision !== file.revision) {
        return; // reject stale update
      }

      const revision = file.revision + 1;
      room.files.set(fileId, { content, revision });

      io.to(roomId).emit("file:update", {
        fileId,
        content,
        revision,
      });

      const node = room.tree.find((n) => n.id === fileId);
      if (node?.path) {
        await saveFile(roomId, node.path, content);
      }
    }
  );

  /* -------- Cursor -------- */

  socket.on("cursor:update", (cursor) => {
    if (
      cursor &&
      cursor.roomId &&
      cursor.fileId &&
      cursor.clientId
    ) {
      socket.to(cursor.roomId).emit("cursor:update", cursor);
    }
  });

  /* -------- Terminal (basic) -------- */

  socket.on("terminal:start", ({ roomId }) => {
    io.to(roomId).emit("terminal:session", {
      id: randomUUID(),
      roomId,
      status: "running",
    });
  });

  socket.on("terminal:stop", ({ roomId }) => {
    io.to(roomId).emit("terminal:session", {
      id: randomUUID(),
      roomId,
      status: "stopped",
    });
  });

  socket.on("terminal:input", ({ roomId, input }) => {
    io.to(roomId).emit("terminal:log", {
      id: randomUUID(),
      timestamp: Date.now(),
      message: `$ ${input}`,
      type: "stdout",
    });
  });

  /* -------- Disconnect -------- */

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
  });
});

/* ---------------- Start ---------------- */

const PORT = process.env.PORT || 6969;
server.listen(PORT, () => {
  console.log(`DevSync realtime server running on ${PORT}`);
});
