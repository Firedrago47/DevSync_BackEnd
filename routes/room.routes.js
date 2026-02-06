const express = require("express");
const roomService = require("../storage/room.service");

const router = express.Router();

router.get("/:roomId", async (req, res) => {
  const { roomId } = req.params;

  try {
    const room = await roomService.getRoomWithMembers(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    return res.json({
      id: room.id,
      name: room.name,
      ownerId: room.ownerId,
      members: room.members,
    });
  } catch (err) {
    console.error("Failed to fetch room:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
