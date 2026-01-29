/* ===============================
   server.js – DevSync Unified Realtime Server
   Production-correct + Supabase-ready
=============================== */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { randomUUID } = require("crypto");
const Y = require("yjs");
require("dotenv").config();

const storage = require("./storage");
const roomService = require("./storage/room.service");

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
});

/**
 * rooms = Map<roomId, {
 *   tree: FSNode[],
 *   docs: Map<fileId, Y.Doc>,
 *   presence: Map<socketId, PresenceData>,
 *   lastActive: number
 * }>
 */
const rooms = new Map();

/* ---------------- Storage helpers ---------------- */

async function loadTree(roomId) {
  try {
    const buffer = await storage.getObject(
      `rooms/${roomId}/tree.json`
    );
    return JSON.parse(buffer.toString("utf-8"));
  } catch {
    return [];
  }
}

async function saveTree(roomId, tree) {
  await storage.putObject(
    `rooms/${roomId}/tree.json`,
    Buffer.from(JSON.stringify(tree)),
    "application/json"
  );
}

async function loadYDoc(roomId, fileId) {
  try {
    const buffer = await storage.getObject(
      `rooms/${roomId}/files/${fileId}.ydoc`
    );
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

async function saveYDoc(roomId, fileId, doc) {
  const update = Y.encodeStateAsUpdate(doc);
  await storage.putObject(
    `rooms/${roomId}/files/${fileId}.ydoc`,
    Buffer.from(update),
    "application/octet-stream"
  );
}

/* ---------------- FS helpers ---------------- */

function computePath(tree, parentId, name) {
  if (!parentId) return `/${name}`;
  const parent = tree.find((n) => n.id === parentId);
  return parent ? `${parent.path}/${name}` : `/${name}`;
}

function deleteSubtree(tree, rootId) {
  const remove = new Set([rootId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const node of tree) {
      if (remove.has(node.parentId) && !remove.has(node.id)) {
        remove.add(node.id);
        changed = true;
      }
    }
  }

  return {
    newTree: tree.filter((n) => !remove.has(n.id)),
    removedIds: [...remove],
  };
}

/* ---------------- Yjs ---------------- */

async function getYDoc(roomId, fileId) {
  let room = rooms.get(roomId);

  if (!room) {
    room = {
      tree: await loadTree(roomId),
      docs: new Map(),
      presence: new Map(),
      lastActive: Date.now(),
    };
    rooms.set(roomId, room);
  }

  room.lastActive = Date.now();

  if (!room.docs.has(fileId)) {
    const doc = new Y.Doc();

    const saved = await loadYDoc(roomId, fileId);
    if (saved) Y.applyUpdate(doc, saved);

    let debounce;
    doc.on("update", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        saveYDoc(roomId, fileId, doc).catch(console.error);
      }, 2000);
    });

    room.docs.set(fileId, doc);
  }

  return room.docs.get(fileId);
}

/* ---------------- Socket.IO ---------------- */

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  /* -------- Room create -------- */

  socket.on("room:create", async ({ name, userId }) => {
    try {
      const { roomId } = await roomService.createRoom({
        name,
        ownerId: userId,
      });

      socket.emit("room:created", { roomId });
    } catch {
      socket.emit("room:error", {
        message: "Room creation failed",
      });
    }
  });

  /* -------- Room join -------- */

  socket.on("room:join", async ({ roomId, userId }) => {
    const member = await roomService.isMember(roomId, userId);
    if (!member) {
      socket.emit("room:error", {
        message: "Unauthorized",
      });
      return;
    }

    socket.userId = userId;
    socket.join(roomId);

    let room = rooms.get(roomId);
    if (!room) {
      room = {
        tree: await loadTree(roomId),
        docs: new Map(),
        presence: new Map(),
        lastActive: Date.now(),
      };
      rooms.set(roomId, room);
    }

    room.lastActive = Date.now();

    room.presence.set(socket.id, {
      userId,
      name: userId.slice(0, 8),
      color: `#${Math.floor(Math.random() * 16777215).toString(16)}`,
      online: true,
      lastSeen: Date.now(),
    });

    socket.emit("room:snapshot", {
      roomId,
      tree: room.tree,
    });

    socket.emit("fs:snapshot", {
      roomId,
      nodes: room.tree,
    });

    socket.emit("presence:update", {
      roomId,
      users: [...room.presence.values()],
    });

    socket.to(roomId).emit(
      "presence:join",
      room.presence.get(socket.id)
    );
  });

  /* -------- Filesystem -------- */

  socket.on("fs:create", async ({ roomId, parentId, name, type }) => {
    const member = await roomService.isMember(
      roomId,
      socket.userId
    );
    if (!member || member.role === "viewer") return;

    const room = rooms.get(roomId);
    if (!room) return;

    const node = {
      id: randomUUID(),
      name,
      type,
      parentId: parentId ?? null,
      path: computePath(room.tree, parentId, name),
      updatedAt: Date.now(),
    };

    room.tree.push(node);
    await saveTree(roomId, room.tree);

    io.to(roomId).emit("fs:create", node);
  });

  socket.on("fs:rename", async ({ roomId, id, name }) => {
    const member = await roomService.isMember(
      roomId,
      socket.userId
    );
    if (!member || member.role === "viewer") return;

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
    const member = await roomService.isMember(
      roomId,
      socket.userId
    );
    if (!member || member.role === "viewer") return;

    const room = rooms.get(roomId);
    if (!room) return;

    const { newTree, removedIds } = deleteSubtree(
      room.tree,
      id
    );
    room.tree = newTree;

    await saveTree(roomId, room.tree);

    for (const fileId of removedIds) {
      await storage
        .deleteObject(
          `rooms/${roomId}/files/${fileId}.ydoc`
        )
        .catch(() => {});
      room.docs.delete(fileId);
    }

    io.to(roomId).emit("fs:delete", { id });
  });

  /* -------- Yjs -------- */

  socket.on("yjs:join", async ({ roomId, fileId }) => {
    const doc = await getYDoc(roomId, fileId);
    socket.emit("yjs:sync", {
      fileId,
      update: Array.from(Y.encodeStateAsUpdate(doc)),
    });
  });

  socket.on("yjs:update", async ({ roomId, fileId, update }) => {
    const doc = await getYDoc(roomId, fileId);
    const bytes =
      update instanceof Uint8Array
        ? update
        : new Uint8Array(update);

    Y.applyUpdate(doc, bytes);

    socket.to(roomId).emit("yjs:update", {
      fileId,
      update: Array.from(bytes),
    });
  });

  /* -------- Awareness -------- */

  socket.on("awareness:update", (payload) => {
    socket
      .to(payload.roomId)
      .emit("awareness:update", payload);
  });

  /* -------- Disconnect -------- */

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      const presence = room.presence.get(socket.id);
      if (presence) {
        room.presence.delete(socket.id);
        io.to(roomId).emit("presence:leave", {
          userId: presence.userId,
        });
      }
    }
  });
});

/* ---------------- Room GC ---------------- */

setInterval(() => {
  const now = Date.now();

  for (const [roomId, room] of rooms.entries()) {
    if (
      room.presence.size === 0 &&
      now - room.lastActive > 30 * 60 * 1000
    ) {
      rooms.delete(roomId);
      console.log("GC room", roomId);
    }
  }
}, 60 * 1000);

/* ---------------- Start ---------------- */

const PORT = process.env.PORT || 6969;
server.listen(PORT, () => {
  console.log(`✅ DevSync server running on ${PORT}`);
});

/* ---------------- Shutdown ---------------- */

process.on("SIGTERM", () => {
  console.log("SIGTERM received");
  server.close(() => process.exit(0));
});
