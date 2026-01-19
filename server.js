/* ===============================
   server.js – DevSync Unified Realtime Server
   Fixed version with proper Yjs handling
=============================== */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { randomUUID } = require("crypto");
const Y = require("yjs");
require("dotenv").config();

const storage = require("./storage");

/* ---------------- Setup ---------------- */

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || "http://localhost:3000",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

/**
 * rooms = Map<roomId, {
 *   tree: FSNode[],
 *   docs: Map<fileId, Y.Doc>,
 *   presence: Map<socketId, PresenceData>
 * }>
 */
const rooms = new Map();

/* ---------------- Storage helpers ---------------- */

async function loadTree(roomId) {
  try {
    const raw = await storage.getObject(`rooms/${roomId}/tree.json`);
    return JSON.parse(raw);
  } catch (err) {
    console.log(`No tree found for room ${roomId}, creating new`);
    return [];
  }
}

async function saveTree(roomId, tree) {
  try {
    await storage.putObject(
      `rooms/${roomId}/tree.json`,
      JSON.stringify(tree),
      "application/json"
    );
  } catch (err) {
    console.error(`Failed to save tree for ${roomId}:`, err);
  }
}

async function loadYDoc(roomId, fileId) {
  try {
    const raw = await storage.getObject(`rooms/${roomId}/files/${fileId}.ydoc`);
    const buffer = Buffer.from(raw, "base64");
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

async function saveYDoc(roomId, fileId, doc) {
  try {
    const update = Y.encodeStateAsUpdate(doc);
    const base64 = Buffer.from(update).toString("base64");
    await storage.putObject(
      `rooms/${roomId}/files/${fileId}.ydoc`,
      base64,
      "application/octet-stream"
    );
  } catch (err) {
    console.error(`Failed to save Yjs doc for ${fileId}:`, err);
  }
}

/* ---------------- Filesystem utils ---------------- */

function computePath(tree, parentId, name) {
  if (!parentId) return `/${name}`;
  const parent = tree.find((n) => n.id === parentId);
  if (!parent) return `/${name}`;
  return `${parent.path}/${name}`;
}

function deleteSubtree(tree, id) {
  const toDelete = new Set([id]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const node of tree) {
      if (toDelete.has(node.parentId) && !toDelete.has(node.id)) {
        toDelete.add(node.id);
        changed = true;
      }
    }
  }

  return tree.filter((n) => !toDelete.has(n.id));
}

/* ---------------- Yjs helpers ---------------- */

async function getYDoc(roomId, fileId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { 
      tree: await loadTree(roomId), 
      docs: new Map(),
      presence: new Map()
    };
    rooms.set(roomId, room);
  }

  if (!room.docs.has(fileId)) {
    const doc = new Y.Doc();
    
    // Try to load existing state
    const savedState = await loadYDoc(roomId, fileId);
    if (savedState) {
      Y.applyUpdate(doc, savedState);
    }
    
    room.docs.set(fileId, doc);
    
    // Auto-save on changes (debounced)
    let saveTimeout;
    doc.on("update", () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        saveYDoc(roomId, fileId, doc);
      }, 2000);
    });
  }

  return room.docs.get(fileId);
}

/* ---------------- Socket.IO ---------------- */

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  /* -------- Room Join -------- */

  socket.on("room:join", async ({ roomId, userId }) => {
    console.log(`${socket.id} joining room ${roomId}`);
    
    socket.join(roomId);

    let room = rooms.get(roomId);
    if (!room) {
      room = {
        tree: await loadTree(roomId),
        docs: new Map(),
        presence: new Map(),
      };
      rooms.set(roomId, room);
    }

    // Add to presence
    room.presence.set(socket.id, {
      userId: userId || socket.id,
      name: userId?.slice(0, 8) || socket.id.slice(0, 6),
      color: `#${Math.floor(Math.random() * 16777215).toString(16)}`,
      online: true,
      lastSeen: Date.now(),
    });

    // Send file tree snapshot
    socket.emit("fs:snapshot", {
      roomId,
      nodes: room.tree,
    });

    // Send presence snapshot
    const users = Array.from(room.presence.values());
    socket.emit("presence:update", {
      roomId,
      users,
    });

    // Notify others
    socket.to(roomId).emit("presence:join", room.presence.get(socket.id));
  });

  socket.on("room:leave", ({ roomId }) => {
    console.log(`${socket.id} leaving room ${roomId}`);
    
    const room = rooms.get(roomId);
    if (room) {
      room.presence.delete(socket.id);
      socket.to(roomId).emit("presence:leave", { userId: socket.id });
    }
    
    socket.leave(roomId);
  });

  /* -------- Filesystem -------- */

  socket.on("fs:create", async ({ roomId, parentId, name, type }) => {
    console.log(`Creating ${type} "${name}" in room ${roomId}`);
    
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`Room ${roomId} not found`);
      return;
    }

    const id = randomUUID();
    const path = computePath(room.tree, parentId, name);

    const node = {
      id,
      name,
      type,
      parentId: parentId || null,
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

  /* -------- Yjs CRDT -------- */

  socket.on("yjs:join", async ({ roomId, fileId }) => {
    console.log(`${socket.id} joining Yjs doc ${fileId}`);
    
    const doc = await getYDoc(roomId, fileId);
    const update = Y.encodeStateAsUpdate(doc);

    socket.emit("yjs:sync", {
      fileId,
      update: Array.from(update),
    });
  });

  socket.on("yjs:update", async ({ roomId, fileId, update }) => {
    const doc = await getYDoc(roomId, fileId);

    try {
      // Convert array back to Uint8Array if needed
      const updateBytes = 
        update instanceof Uint8Array 
          ? update 
          : new Uint8Array(update);

      Y.applyUpdate(doc, updateBytes);

      // Broadcast to others in room (excluding sender)
      socket.to(roomId).emit("yjs:update", {
        fileId,
        update: Array.from(updateBytes),
      });
    } catch (err) {
      console.error("Error applying Yjs update:", err);
    }
  });

  /* -------- Awareness (RELAY ONLY) -------- */

  socket.on("awareness:update", (payload) => {
    socket.to(payload.roomId).emit("awareness:update", payload);
  });

  /* -------- Disconnect -------- */

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    // Remove from all rooms
    for (const [roomId, room] of rooms.entries()) {
      if (room.presence.has(socket.id)) {
        room.presence.delete(socket.id);
        io.to(roomId).emit("presence:leave", { userId: socket.id });
      }
    }
  });
});

/* ---------------- Start ---------------- */

const PORT = process.env.PORT || 6969;
server.listen(PORT, () => {
  console.log(`✅ DevSync server running on port ${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});