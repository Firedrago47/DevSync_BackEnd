/* ===============================
server.js – DevSync Unified Realtime Server
Production-correct + Supabase-ready
=============================== */

const http = require("http");
require("dotenv").config();

const { createApp } = require("./app");
const { initSocket } = require("./socket");

/* ---------------- Setup ---------------- */

const app = createApp();
const server = http.createServer(app);
initSocket(server);

/* ---------------- Start ---------------- */

const PORT = process.env.PORT || 6969;
server.listen(PORT, () => {
  console.log(`DevSync server running on ${PORT}`);
});

/* ---------------- Shutdown ---------------- */

process.on("SIGTERM", () => {
  console.log("SIGTERM received");
  server.close(() => process.exit(0));
});
