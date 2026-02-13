const crypto = require("crypto");
const roomService = require("../storage/room.service");
const { getRoom, getYDoc } = require("./state");

const TERMINAL_TIMEOUT_MS = Number(process.env.TERMINAL_TIMEOUT_MS || 15000);
const MAX_LOG_CHARS = Number(process.env.TERMINAL_MAX_LOG_CHARS || 8000);
const PISTON_URL =
  process.env.PISTON_URL || "https://emkc.org/api/v2/piston/execute";
const PISTON_PYTHON_VERSION = process.env.PISTON_PYTHON_VERSION || "*";

const sessions = new Map();

function makeSessionKey(socketId, roomId) {
  return `${socketId}:${roomId}`;
}

function clipLog(message) {
  if (!message) return "";
  if (message.length <= MAX_LOG_CHARS) return message;
  return `${message.slice(0, MAX_LOG_CHARS)}\n...output truncated...`;
}

function emitSession(socket, roomId, id, status) {
  socket.emit("terminal:session", { id, roomId, status });
}

function emitLog(socket, message, type = "system") {
  socket.emit("terminal:log", {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    message: clipLog(message),
    type,
  });
}

function pickPythonNode(tree, preferredFileId) {
  const files = tree.filter((node) => node.type === "file");

  if (preferredFileId) {
    const preferred = files.find((node) => node.id === preferredFileId);
    if (preferred && preferred.name.endsWith(".py")) return preferred;
  }

  const priority = ["main.py", "app.py", "run.py"];
  for (const name of priority) {
    const node = files.find((n) => n.name === name);
    if (node) return node;
  }

  return files.find((n) => n.name.endsWith(".py")) || null;
}

async function getPythonSource(roomId, preferredFileId) {
  const room = await getRoom(roomId);
  const node = pickPythonNode(room.tree, preferredFileId);
  if (!node) return null;

  const doc = await getYDoc(roomId, node.id);
  const source = doc.getText("content").toString();

  return { node, source };
}

async function cleanupSession(session) {
  if (session.timeout) clearTimeout(session.timeout);
  if (session.abortController) session.abortController.abort();
}

function registerTerminalHandlers(io, socket) {
  socket.on("terminal:start", async ({ roomId, fileId }) => {
    const key = makeSessionKey(socket.id, roomId);
    const existing = sessions.get(key);
    if (existing) {
      await cleanupSession(existing);
      sessions.delete(key);
    }

    const sessionId = crypto.randomUUID();

    try {
      const member = await roomService.isMember(roomId, socket.userId);
      if (!member) {
        emitSession(socket, roomId, sessionId, "error");
        emitLog(socket, "You are not allowed to run code in this room.", "stderr");
        return;
      }

      const sourceFile = await getPythonSource(roomId, fileId);
      if (!sourceFile) {
        emitSession(socket, roomId, sessionId, "error");
        emitLog(socket, "No Python file found in the room tree.", "stderr");
        return;
      }

      const abortController = new AbortController();
      const session = {
        id: sessionId,
        roomId,
        stopped: false,
        abortController,
        timeout: null,
      };
      sessions.set(key, session);

      emitSession(socket, roomId, sessionId, "starting");
      emitLog(socket, `Running ${sourceFile.node.name} with Piston...`, "system");
      emitSession(socket, roomId, sessionId, "running");

      session.timeout = setTimeout(() => {
        if (!session.stopped) {
          emitLog(
            socket,
            `Execution timed out after ${TERMINAL_TIMEOUT_MS}ms`,
            "stderr"
          );
          abortController.abort();
        }
      }, TERMINAL_TIMEOUT_MS);

      const response = await fetch(PISTON_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: abortController.signal,
        body: JSON.stringify({
          language: "python",
          version: PISTON_PYTHON_VERSION,
          files: [
            {
              name: sourceFile.node.name,
              content: sourceFile.source,
            },
          ],
          run_timeout: TERMINAL_TIMEOUT_MS,
        }),
      });

      if (!response.ok) {
        emitSession(socket, roomId, sessionId, "error");
        emitLog(socket, `Piston request failed: HTTP ${response.status}`, "stderr");
        await cleanupSession(session);
        sessions.delete(key);
        return;
      }

      const payload = await response.json();
      const run = payload?.run || {};
      const stdout = run.stdout ? String(run.stdout) : "";
      const stderr = run.stderr ? String(run.stderr) : "";
      const code = Number.isInteger(run.code) ? run.code : null;
      const signal = run.signal ? String(run.signal) : null;

      if (stdout) emitLog(socket, stdout, "stdout");
      if (stderr) emitLog(socket, stderr, "stderr");
      if (!stdout && !stderr && typeof run.output === "string" && run.output) {
        emitLog(socket, run.output, code === 0 ? "stdout" : "stderr");
      }
      if (!stdout && !stderr && !run.output && code === 0) {
        emitLog(socket, "(no output)", "system");
      }

      const status = code === 0 ? "stopped" : "error";
      emitLog(
        socket,
        `Process finished (code=${code ?? "null"}, signal=${signal ?? "none"})`,
        "system"
      );
      emitSession(socket, roomId, sessionId, status);
      await cleanupSession(session);
      sessions.delete(key);
    } catch (err) {
      const active = sessions.get(key);
      if (!active) return;

      if (active.stopped || err?.name === "AbortError") {
        emitSession(socket, roomId, sessionId, "stopped");
        await cleanupSession(active);
        sessions.delete(key);
        return;
      }

      emitSession(socket, roomId, sessionId, "error");
      emitLog(socket, err.message || "Failed to run code via Piston", "stderr");
      await cleanupSession(active);
      sessions.delete(key);
    }
  });

  socket.on("terminal:input", ({ roomId, input }) => {
    void roomId;
    void input;
    emitLog(socket, "Interactive stdin is not supported with Piston runs.", "system");
  });

  socket.on("terminal:stop", async ({ roomId }) => {
    const key = makeSessionKey(socket.id, roomId);
    const session = sessions.get(key);
    if (!session) return;

    session.stopped = true;
    emitLog(socket, "Stopping process...", "system");
    await cleanupSession(session);
  });

  socket.on("disconnect", async () => {
    const keys = [...sessions.keys()].filter((k) => k.startsWith(`${socket.id}:`));
    for (const key of keys) {
      const session = sessions.get(key);
      if (!session) continue;
      await cleanupSession(session);
      sessions.delete(key);
    }
  });
}

module.exports = registerTerminalHandlers;
