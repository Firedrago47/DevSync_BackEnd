const { randomUUID } = require("crypto");
const storage = require("../storage");
const roomService = require("../storage/room.service");
const { rooms, computePath, deleteSubtree, saveTree } = require("./state");

function registerFsHandlers(io, socket) {
  socket.on("fs:create", async ({ roomId, parentId, name, type }) => {
    const member = await roomService.isMember(roomId, socket.userId);
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
    const member = await roomService.isMember(roomId, socket.userId);
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
    const member = await roomService.isMember(roomId, socket.userId);
    if (!member || member.role === "viewer") return;

    const room = rooms.get(roomId);
    if (!room) return;

    const { newTree, removedIds } = deleteSubtree(room.tree, id);
    room.tree = newTree;

    await saveTree(roomId, room.tree);

    for (const fileId of removedIds) {
      await storage
        .deleteObject(`rooms/${roomId}/files/${fileId}.ydoc`)
        .catch(() => {});
      room.docs.delete(fileId);
    }

    io.to(roomId).emit("fs:delete", { id });
  });
}

module.exports = registerFsHandlers;
