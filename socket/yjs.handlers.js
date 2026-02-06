const Y = require("yjs");
const { getYDoc } = require("./state");

function registerYjsHandlers(io, socket) {
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
      update instanceof Uint8Array ? update : new Uint8Array(update);

    Y.applyUpdate(doc, bytes);

    socket.to(roomId).emit("yjs:update", {
      fileId,
      update: Array.from(bytes),
    });
  });
}

module.exports = registerYjsHandlers;
