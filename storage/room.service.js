const supabase = require("./supabase.db");

/* ---------- Create room ---------- */
async function createRoom({ name, ownerId }) {
  const roomId = crypto.randomUUID();

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

  if (error) return null;

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
  const { data } = await supabase
    .from("room_members")
    .select("role")
    .eq("room_id", roomId)
    .eq("user_id", userId)
    .single();
  if(error) return null;
  return data;
}

module.exports = {
  createRoom,
  getRoomWithMembers,
  isMember,
};
