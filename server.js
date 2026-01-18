/* ===============================
   server.js — DevSync Unified Realtime Server
   Socket.IO + Yjs (CRDT)
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

const awarenessStates = new Map(); 


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
 * rooms = Map<roomId, {
 *   tree: FSNode[],
 *   docs: Map<fileId, Y.Doc>
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

/* ---------------- Filesystem utils ---------------- */

function computePath(tree, parentId, name) {
  if (!parentId) return name;
  const parent = tree.find((n) => n.id === parentId);
  return parent ? `${parent.path}/${name}` : name;
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

function getYDoc(roomId, fileId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { tree: [], docs: new Map() };
    rooms.set(roomId, room);
  }

  if (!room.docs.has(fileId)) {
    const doc = new Y.Doc();
    room.docs.set(fileId, doc);
  }

  return room.docs.get(fileId);
}

/* ---------------- Socket.IO ---------------- */

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  /* -------- Room Join -------- */

  socket.on("room:join", async ({ roomId, user }) => {
    socket.join(roomId);

    let room = rooms.get(roomId);
    if (!room) {
      room = {
        tree: await loadTree(roomId),
        docs: new Map(),
      };
      rooms.set(roomId, room);
    }

    socket.emit("fs:snapshot", {
      roomId,
      nodes: room.tree,
    });

    socket.to(roomId).emit("presence:join", {
      userId: user.id,
      name: user.name,
      color: user.color,
    });
  });

  /* -------- Yjs Awareness (Cursors) -------- */

socket.on("awareness:update", ({ roomId, fileId, clientId, state }) => {
  if (!roomId || !fileId || !clientId) return;

  const key = `${roomId}:${fileId}`;

  if (!awarenessStates.has(key)) {
    awarenessStates.set(key, new Map());
  }

  const map = awarenessStates.get(key);

  if (state === null) {
    map.delete(clientId);
  } else {
    map.set(clientId, state);
  }

  socket.to(roomId).emit("awareness:update", {
    fileId,
    clientId,
    state,
  });
});

socket.on("disconnect", () => {
  for (const [key, map] of awarenessStates.entries()) {
    if (map.delete(socket.id)) {
      const [roomId, fileId] = key.split(":");
      socket.to(roomId).emit("awareness:update", {
        fileId,
        clientId: socket.id,
        state: null,
      });
    }
  }
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

  /* -------- Yjs CRDT Editor -------- */

  socket.on("yjs:join", ({ roomId, fileId }) => {
    const doc = getYDoc(roomId, fileId);

    // Send full state
    const update = Y.encodeStateAsUpdate(doc);
    socket.emit("yjs:sync", { fileId, update });
  });

  socket.on("yjs:update", ({ roomId, fileId, update }) => {
    const doc = getYDoc(roomId, fileId);

    Y.applyUpdate(doc, update);
    socket.to(roomId).emit("yjs:update", {
      fileId,
      update,
    });
  });

  /* -------- Cursor -------- */

  socket.on("cursor:update", (cursor) => {
    if (cursor?.roomId) {
      socket.to(cursor.roomId).emit("cursor:update", cursor);
    }
  });

  /* -------- Disconnect -------- */

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
  });
});

/* ---------------- Start ---------------- */

const PORT = process.env.PORT || 6969;
server.listen(PORT, () => {
  console.log(`DevSync unified server running on ${PORT}`);
});
