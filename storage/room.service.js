const crypto = require("crypto");

const DEV_MODE = process.env.DEV_MODE === "true";

let supabase = null;
if (!DEV_MODE) {
  supabase = require("./supabase.db");
}

const devRooms = new Map();
const devMembers = new Map();
const pendingJoinRequests = new Map();

function getMemberKey(roomId, userId) {
  return `${roomId}:${userId}`;
}

function getPendingKey(roomId, userId) {
  return `${roomId}:${userId}`;
}

/* ---------- Create room ---------- */
async function createRoom({ name, ownerId }) {
  const roomId = crypto.randomUUID();

  if (DEV_MODE) {
    devRooms.set(roomId, {
      id: roomId,
      name,
      ownerId,
    });

    devMembers.set(getMemberKey(roomId, ownerId), {
      roomId,
      userId: ownerId,
      role: "owner",
    });

    return { roomId };
  }

  const { error: roomErr } = await supabase
    .from("rooms")
    .insert({
      id: roomId,
      name,
      owner_id: ownerId,
    });

  if (roomErr) throw roomErr;

  const { error: memberErr } = await supabase
    .from("room_members")
    .insert({
      room_id: roomId,
      user_id: ownerId,
      role: "owner",
    });

  if (memberErr) throw memberErr;

  return { roomId };
}

/* ---------- Get room + members ---------- */
async function getRoomWithMembers(roomId) {
  if (DEV_MODE) {
    const room = devRooms.get(roomId);
    if (!room) return null;

    const members = [];
    for (const member of devMembers.values()) {
      if (member.roomId !== roomId) continue;
      members.push({
        userId: member.userId,
        role: member.role,
      });
    }

    return {
      id: room.id,
      name: room.name,
      ownerId: room.ownerId,
      members,
    };
  }

  const { data, error } = await supabase
    .from("rooms")
    .select(`
      id,
      name,
      owner_id,
      room_members (
        user_id,
        role
      )
    `)
    .eq("id", roomId)
    .single();

  if (error) {
    console.error("getRoomWithMembers error:", error);
    return null;
  }

  return {
    id: data.id,
    name: data.name,
    ownerId: data.owner_id,
    members: data.room_members.map((m) => ({
      userId: m.user_id,
      role: m.role,
    })),
  };
}

/* ---------- Check membership ---------- */
async function isMember(roomId, userId) {
  if (DEV_MODE) {
    const room = devRooms.get(roomId);
    if (!room) return null;

    const key = getMemberKey(roomId, userId);
    const existing = devMembers.get(key);
    return existing ? { role: existing.role } : null;
  }

  const { data, error } = await supabase
    .from("room_members")
    .select("role")
    .eq("room_id", roomId)
    .eq("user_id", userId)
    .maybeSingle(); 

  if (error) {
    console.error("isMember error:", error);
    return null;
  }

  return data; // { role } | null
}

/* ---------- Pending join requests ---------- */
async function upsertPendingJoinRequest({
  roomId,
  userId,
  name,
  email,
  requestedAt,
}) {
  const payload = {
    roomId,
    userId,
    name: name || userId,
    email: email || null,
    requestedAt:
      typeof requestedAt === "number" ? requestedAt : Date.now(),
  };

  pendingJoinRequests.set(getPendingKey(roomId, userId), payload);
  return payload;
}

async function getPendingJoinRequest(roomId, userId) {
  return pendingJoinRequests.get(getPendingKey(roomId, userId)) || null;
}

async function clearPendingJoinRequest(roomId, userId) {
  pendingJoinRequests.delete(getPendingKey(roomId, userId));
}

/* ---------- Assign role ---------- */
async function assignRole({ roomId, userId, role }) {
  if (DEV_MODE) {
    devMembers.set(getMemberKey(roomId, userId), {
      roomId,
      userId,
      role,
    });
    return { role };
  }

  const { error } = await supabase.from("room_members").upsert(
    {
      room_id: roomId,
      user_id: userId,
      role,
    },
    {
      onConflict: "room_id,user_id",
    }
  );

  if (error) throw error;
  return { role };
}

module.exports = {
  createRoom,
  getRoomWithMembers,
  isMember,
  upsertPendingJoinRequest,
  getPendingJoinRequest,
  clearPendingJoinRequest,
  assignRole,
};
