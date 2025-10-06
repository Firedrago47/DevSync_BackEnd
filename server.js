const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { runCode } = require('./runCode');
const { uploadCode } = require('./aws');

require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

const rooms = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomId }) => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = '';
    socket.emit('init-code', rooms[roomId]);
  });

  socket.on('code-change', ({ roomId, code }) => {
    rooms[roomId] = code;
    socket.to(roomId).emit('code-change', code);
  });

  socket.on('language-change', ({ roomId, language }) => {
    socket.to(roomId).emit('language-change', language);
  });

  socket.on('run-code', async ({ code, roomId }) => {
  const result = await runCode(code); // Python only
  io.to(roomId).emit('code-output', result);

  try {
    await uploadCode(roomId, code);
    console.log(`Code for room ${roomId} uploaded to S3`);
  } catch (err) {
    console.error(`Failed to upload code for room ${roomId}:`, err);
  }
});

});

server.listen(6969, () => console.log('Backend running on http://localhost:6969'));
