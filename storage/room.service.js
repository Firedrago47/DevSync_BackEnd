const crypto = require("crypto");

const DEV_MODE = process.env.DEV_MODE === "true";

let supabase = null;
if (!DEV_MODE) {
  supabase = require("./supabase.db");
}

const devRooms = new Map();
const devMembers = new Map();

function getMemberKey(roomId, userId) {
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
    if (existing) {
      return { role: existing.role };
    }

    const autoAdded = {
      roomId,
      userId,
      role: "editor",
    };
    devMembers.set(key, autoAdded);
    return { role: autoAdded.role };
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

module.exports = {
  createRoom,
  getRoomWithMembers,
  isMember,
};
