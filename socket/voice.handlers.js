const roomService = require("../storage/room.service");

const voiceRoomBySocket = new Map();
const voicePeersByRoom = new Map();

function toDisplayName(rawName, userId) {
  if (typeof rawName === "string" && rawName.trim()) {
    return rawName.trim();
  }
  if (typeof userId === "string" && userId) {
    return userId.slice(0, 8);
  }
  return "Anonymous";
}

function getRoomPeers(roomId) {
  let peers = voicePeersByRoom.get(roomId);
  if (!peers) {
    peers = new Map();
    voicePeersByRoom.set(roomId, peers);
  }
  return peers;
}

function buildPeerPayload(socketId, peer) {
  return {
    socketId,
    userId: peer.userId,
    name: peer.name,
    muted: !!peer.muted,
  };
}

function cleanupVoicePeer(io, socket) {
  const roomId = voiceRoomBySocket.get(socket.id);
  if (!roomId) return;

  voiceRoomBySocket.delete(socket.id);
  const peers = voicePeersByRoom.get(roomId);
  if (!peers) return;

  peers.delete(socket.id);
  if (peers.size === 0) {
    voicePeersByRoom.delete(roomId);
  }

  io.to(roomId).emit("webrtc:peer-left", {
    roomId,
    socketId: socket.id,
    userId: socket.userId,
  });
}

function canUseVoice(socket, roomId) {
  return typeof roomId === "string" && roomId && socket.rooms.has(roomId);
}

function registerVoiceHandlers(io, socket) {
  socket.on("webrtc:join", async (payload) => {
    try {
      const roomId =
        payload && typeof payload.roomId === "string" ? payload.roomId : "";
      if (!canUseVoice(socket, roomId)) return;

      const member = await roomService.isMember(roomId, socket.userId);
      if (!member) {
        socket.emit("room:error", {
          roomId,
          code: "forbidden",
          message: "You are not allowed to join voice in this room",
        });
        return;
      }

      cleanupVoicePeer(io, socket);

      const peers = getRoomPeers(roomId);
      const nextPeer = {
        userId: socket.userId,
        name: toDisplayName(payload?.name, socket.userId),
        muted: !!payload?.muted,
      };

      const existingPeers = [];
      for (const [peerSocketId, peer] of peers.entries()) {
        existingPeers.push(buildPeerPayload(peerSocketId, peer));
      }

      peers.set(socket.id, nextPeer);
      voiceRoomBySocket.set(socket.id, roomId);

      socket.emit("webrtc:peers", {
        roomId,
        peers: existingPeers,
      });

      socket.to(roomId).emit("webrtc:peer-joined", {
        roomId,
        peer: buildPeerPayload(socket.id, nextPeer),
      });
    } catch (err) {
      console.error("webrtc:join failed:", err);
    }
  });

  socket.on("webrtc:leave", (payload) => {
    const roomId =
      payload && typeof payload.roomId === "string" ? payload.roomId : "";
    if (!roomId) return;
    if (voiceRoomBySocket.get(socket.id) !== roomId) return;

    cleanupVoicePeer(io, socket);
  });

  socket.on("webrtc:mute", (payload) => {
    const roomId =
      payload && typeof payload.roomId === "string" ? payload.roomId : "";
    const muted = !!payload?.muted;
    if (!roomId) return;
    if (voiceRoomBySocket.get(socket.id) !== roomId) return;

    const peers = voicePeersByRoom.get(roomId);
    const peer = peers?.get(socket.id);
    if (!peer) return;

    peer.muted = muted;
    io.to(roomId).emit("webrtc:peer-updated", {
      roomId,
      peer: buildPeerPayload(socket.id, peer),
    });
  });

  socket.on("webrtc:offer", (payload) => {
    const roomId =
      payload && typeof payload.roomId === "string" ? payload.roomId : "";
    const targetSocketId =
      payload && typeof payload.targetSocketId === "string"
        ? payload.targetSocketId
        : "";
    if (!roomId || !targetSocketId) return;
    if (voiceRoomBySocket.get(socket.id) !== roomId) return;

    const peers = voicePeersByRoom.get(roomId);
    if (!peers || !peers.has(targetSocketId)) return;

    io.to(targetSocketId).emit("webrtc:offer", {
      roomId,
      fromSocketId: socket.id,
      sdp: payload?.sdp,
    });
  });

  socket.on("webrtc:answer", (payload) => {
    const roomId =
      payload && typeof payload.roomId === "string" ? payload.roomId : "";
    const targetSocketId =
      payload && typeof payload.targetSocketId === "string"
        ? payload.targetSocketId
        : "";
    if (!roomId || !targetSocketId) return;
    if (voiceRoomBySocket.get(socket.id) !== roomId) return;

    const peers = voicePeersByRoom.get(roomId);
    if (!peers || !peers.has(targetSocketId)) return;

    io.to(targetSocketId).emit("webrtc:answer", {
      roomId,
      fromSocketId: socket.id,
      sdp: payload?.sdp,
    });
  });

  socket.on("webrtc:ice-candidate", (payload) => {
    const roomId =
      payload && typeof payload.roomId === "string" ? payload.roomId : "";
    const targetSocketId =
      payload && typeof payload.targetSocketId === "string"
        ? payload.targetSocketId
        : "";
    if (!roomId || !targetSocketId) return;
    if (voiceRoomBySocket.get(socket.id) !== roomId) return;

    const peers = voicePeersByRoom.get(roomId);
    if (!peers || !peers.has(targetSocketId)) return;

    io.to(targetSocketId).emit("webrtc:ice-candidate", {
      roomId,
      fromSocketId: socket.id,
      candidate: payload?.candidate,
    });
  });

  socket.on("disconnect", () => {
    cleanupVoicePeer(io, socket);
  });

  socket.on("room:leave", (payload) => {
    const roomId =
      payload && typeof payload.roomId === "string" ? payload.roomId : "";
    if (!roomId) return;
    if (voiceRoomBySocket.get(socket.id) !== roomId) return;
    cleanupVoicePeer(io, socket);
  });
}

module.exports = registerVoiceHandlers;
