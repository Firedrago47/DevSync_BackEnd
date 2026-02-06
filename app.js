const express = require("express");
const cors = require("cors");

const roomRoutes = require("./routes/room.routes");

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use("/api/rooms", roomRoutes);

  return app;
}

module.exports = { createApp };
