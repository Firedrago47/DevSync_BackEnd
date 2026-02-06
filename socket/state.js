const Y = require("yjs");
const storage = require("../storage");

/**
 * rooms = Map<roomId, {
 *   tree: FSNode[],
 *   docs: Map<fileId, Y.Doc>,
 *   presence: Map<socketId, PresenceData>,
 *   lastActive: number
 * }>
 */
const rooms = new Map();

async function loadTree(roomId) {
  try {
    const buffer = await storage.getObject(`rooms/${roomId}/tree.json`);
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

async function getRoom(roomId) {
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
  return room;
}

async function getYDoc(roomId, fileId) {
  const room = await getRoom(roomId);

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

let gcTimer = null;

function startRoomGC() {
  if (gcTimer) return;

  gcTimer = setInterval(() => {
    const now = Date.now();

    for (const [roomId, room] of rooms.entries()) {
      if (room.presence.size === 0 && now - room.lastActive > 30 * 60 * 1000) {
        rooms.delete(roomId);
        console.log("GC room", roomId);
      }
    }
  }, 60 * 1000);
}

module.exports = {
  rooms,
  loadTree,
  saveTree,
  loadYDoc,
  saveYDoc,
  computePath,
  deleteSubtree,
  getRoom,
  getYDoc,
  startRoomGC,
};
