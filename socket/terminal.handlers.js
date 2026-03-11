const crypto = require("crypto");
const roomService = require("../storage/room.service");
const { getRoom, getYDoc } = require("./state");

const TERMINAL_TIMEOUT_MS = Number(process.env.TERMINAL_TIMEOUT_MS || 15000);
const MAX_LOG_CHARS = Number(process.env.TERMINAL_MAX_LOG_CHARS || 8000);

const JUDGE0_BASE_URL = process.env.JUDGE0_BASE_URL;
const JUDGE0_POLL_INTERVAL_MS = Number(process.env.JUDGE0_POLL_INTERVAL_MS || 750);
const JUDGE0_WAIT_MODE = String(process.env.JUDGE0_WAIT_MODE || "false").toLowerCase() === "true";
const JUDGE0_API_KEY = process.env.JUDGE0_API_KEY || "";
const JUDGE0_API_KEY_HEADER = process.env.JUDGE0_API_KEY_HEADER || "X-RapidAPI-Key";
const JUDGE0_HOST = process.env.JUDGE0_HOST || "";
const JUDGE0_HOST_HEADER = process.env.JUDGE0_HOST_HEADER || "X-RapidAPI-Host";

const sessions = new Map();
const DEFAULT_LANGUAGE_BY_EXTENSION = Object.freeze({
  py: 71, // Python (3.8.1)
  js: 63, // JavaScript (Node.js 12.14.0)
  ts: 74, // TypeScript (3.7.4)
  c: 50, // C (GCC 9.2.0)
  cpp: 54, // C++ (GCC 9.2.0)
  cc: 54,
  cxx: 54,
  java: 62, // Java (OpenJDK 13.0.1)
  go: 60, // Go (1.13.5)
  rs: 73, // Rust (1.40.0)
});
const LANGUAGE_ID_BY_EXTENSION = Object.freeze({
  ...DEFAULT_LANGUAGE_BY_EXTENSION,
  py: Number(process.env.JUDGE0_LANGUAGE_ID_PY || DEFAULT_LANGUAGE_BY_EXTENSION.py),
  js: Number(process.env.JUDGE0_LANGUAGE_ID_JS || DEFAULT_LANGUAGE_BY_EXTENSION.js),
  ts: Number(process.env.JUDGE0_LANGUAGE_ID_TS || DEFAULT_LANGUAGE_BY_EXTENSION.ts),
  c: Number(process.env.JUDGE0_LANGUAGE_ID_C || DEFAULT_LANGUAGE_BY_EXTENSION.c),
  cpp: Number(process.env.JUDGE0_LANGUAGE_ID_CPP || DEFAULT_LANGUAGE_BY_EXTENSION.cpp),
  cc: Number(process.env.JUDGE0_LANGUAGE_ID_CPP || DEFAULT_LANGUAGE_BY_EXTENSION.cc),
  cxx: Number(process.env.JUDGE0_LANGUAGE_ID_CPP || DEFAULT_LANGUAGE_BY_EXTENSION.cxx),
  java: Number(process.env.JUDGE0_LANGUAGE_ID_JAVA || DEFAULT_LANGUAGE_BY_EXTENSION.java),
  go: Number(process.env.JUDGE0_LANGUAGE_ID_GO || DEFAULT_LANGUAGE_BY_EXTENSION.go),
  rs: Number(process.env.JUDGE0_LANGUAGE_ID_RS || DEFAULT_LANGUAGE_BY_EXTENSION.rs),
});

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

function safeUrlHost(url) {
  try {
    return new URL(url).host;
  } catch (_err) {
    return "invalid-url";
  }
}

function getFileExtension(name) {
  if (typeof name !== "string") return "";
  const index = name.lastIndexOf(".");
  if (index < 0 || index === name.length - 1) return "";
  return name.slice(index + 1).toLowerCase();
}

function getLanguageIdForFileName(name) {
  const extension = getFileExtension(name);
  const languageId = LANGUAGE_ID_BY_EXTENSION[extension];
  if (!Number.isInteger(languageId)) return null;
  return { extension, languageId };
}

function getSupportedExtensionsText() {
  return Object.keys(LANGUAGE_ID_BY_EXTENSION)
    .filter((key, index, arr) => arr.indexOf(key) === index)
    .map((key) => `.${key}`)
    .join(", ");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildJudge0Headers() {
  const headers = {
    "Content-Type": "application/json",
  };

  if (JUDGE0_API_KEY) {
    const keyHeader = String(JUDGE0_API_KEY_HEADER || "").trim();
    if (keyHeader) headers[keyHeader] = JUDGE0_API_KEY;
  }

  if (JUDGE0_HOST) {
    const hostHeader = String(JUDGE0_HOST_HEADER || "").trim();
    if (hostHeader) headers[hostHeader] = JUDGE0_HOST;
  }

  return headers;
}

function normalizeExecResult(result) {
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    compileOutput:
      typeof result.compile_output === "string" ? result.compile_output : "",
    message: typeof result.message === "string" ? result.message : "",
    code:
      typeof result.exit_code === "number"
        ? result.exit_code
        : Number.isInteger(result.code)
          ? result.code
          : null,
    signal:
      typeof result.signal === "string"
        ? result.signal
        : typeof result.exit_signal === "string"
          ? result.exit_signal
          : null,
    statusId:
      typeof result.status?.id === "number"
        ? result.status.id
        : typeof result.status_id === "number"
          ? result.status_id
          : null,
    statusDescription:
      typeof result.status?.description === "string"
        ? result.status.description
        : typeof result.status_description === "string"
          ? result.status_description
          : "",
  };
}

async function runWithJudge0(sourceFile, abortController) {
  const baseUrl = JUDGE0_BASE_URL.replace(/\/+$/, "");
  const query = `base64_encoded=false&wait=${JUDGE0_WAIT_MODE ? "true" : "false"}`;
  const submitUrl = `${baseUrl}/submissions?${query}`;
  const language = getLanguageIdForFileName(sourceFile.node.name);
  if (!language) {
    const supported = getSupportedExtensionsText();
    throw new Error(
      `Unsupported file type for execution: ${sourceFile.node.name}. Supported: ${supported}`
    );
  }

  const submitResponse = await fetch(submitUrl, {
    method: "POST",
    headers: buildJudge0Headers(),
    signal: abortController.signal,
    body: JSON.stringify({
      language_id: language.languageId,
      source_code: sourceFile.source,
      stdin: "",
      cpu_time_limit: Math.ceil(TERMINAL_TIMEOUT_MS / 1000),
      wall_time_limit: Math.ceil(TERMINAL_TIMEOUT_MS / 1000),
    }),
  });

  if (!submitResponse.ok) {
    const detail = await submitResponse.text().catch(() => "");
    const host = safeUrlHost(submitUrl);
    const err = new Error(`Judge0 request failed: HTTP ${submitResponse.status} (host=${host})`);
    err.detail = detail;
    throw err;
  }

  const submitPayload = await submitResponse.json();
  if (JUDGE0_WAIT_MODE) {
    return normalizeExecResult(submitPayload || {});
  }

  const token = typeof submitPayload?.token === "string" ? submitPayload.token : "";
  if (!token) {
    throw new Error("Judge0 did not return a submission token");
  }

  const pollUrl = `${baseUrl}/submissions/${token}?base64_encoded=false`;
  // Judge0 pending states: 1=In Queue, 2=Processing
  while (true) {
    const pollResponse = await fetch(pollUrl, {
      method: "GET",
      headers: buildJudge0Headers(),
      signal: abortController.signal,
    });

    if (!pollResponse.ok) {
      const detail = await pollResponse.text().catch(() => "");
      const host = safeUrlHost(pollUrl);
      const err = new Error(`Judge0 poll failed: HTTP ${pollResponse.status} (host=${host})`);
      err.detail = detail;
      throw err;
    }

    const result = normalizeExecResult(await pollResponse.json());
    if (result.statusId !== 1 && result.statusId !== 2) {
      return result;
    }

    await sleep(JUDGE0_POLL_INTERVAL_MS);
  }
}

async function executeSource(sourceFile, abortController) {
  return runWithJudge0(sourceFile, abortController);
}

function pickRunnableNode(tree, preferredFileId) {
  const files = tree.filter((node) => node.type === "file");
  const runnableFiles = files.filter((node) => getLanguageIdForFileName(node.name));

  if (preferredFileId) {
    const preferred = runnableFiles.find((node) => node.id === preferredFileId);
    if (preferred) return preferred;
    const preferredAny = files.find((node) => node.id === preferredFileId);
    if (preferredAny) return preferredAny;
  }

  const priorityPrefixes = ["main", "app", "run", "index"];
  for (const prefix of priorityPrefixes) {
    const prioritized = runnableFiles.find((node) =>
      node.name.toLowerCase().startsWith(`${prefix}.`)
    );
    if (prioritized) return prioritized;
  }

  return runnableFiles[0] || null;
}

async function getSourceFile(roomId, preferredFileId) {
  const room = await getRoom(roomId);
  const node = pickRunnableNode(room.tree, preferredFileId);
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

      const sourceFile = await getSourceFile(roomId, fileId);
      if (!sourceFile) {
        emitSession(socket, roomId, sessionId, "error");
        emitLog(
          socket,
          `No runnable file found. Supported: ${getSupportedExtensionsText()}`,
          "stderr"
        );
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
      const language = getLanguageIdForFileName(sourceFile.node.name);
      emitLog(
        socket,
        `Running ${sourceFile.node.name}${language ? ` (language_id=${language.languageId})` : ""}...`,
        "system"
      );
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

      const result = await executeSource(sourceFile, abortController);
      const stdout = result.stdout;
      const stderr = result.stderr || result.compileOutput;
      const code = result.code;
      const signal = result.signal;

      if (stdout) emitLog(socket, stdout, "stdout");
      if (stderr) emitLog(socket, stderr, "stderr");
      if (!stdout && !stderr && result.message) {
        emitLog(socket, result.message, code === 0 ? "stdout" : "stderr");
      }
      if (!stdout && !stderr && !result.message && code === 0) {
        emitLog(socket, "(no output)", "system");
      }

      const hasJudge0StatusError =
        typeof result.statusId === "number" && result.statusId !== 3;
      const hasExitCodeError = code !== null && code !== 0;
      const status = hasJudge0StatusError || hasExitCodeError ? "error" : "stopped";
      const statusSuffix = result.statusDescription
        ? `, status=${result.statusDescription}`
        : "";
      emitLog(
        socket,
        `Process finished (code=${code ?? "null"}, signal=${signal ?? "none"}${statusSuffix})`,
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
      emitLog(
        socket,
        err.message || "Failed to run code via Judge0",
        "stderr"
      );
      if (err?.detail) {
        emitLog(socket, String(err.detail), "stderr");
      }
      await cleanupSession(active);
      sessions.delete(key);
    }
  });

  socket.on("terminal:input", ({ roomId, input }) => {
    void roomId;
    void input;
    emitLog(socket, "Interactive stdin is not supported with remote runs.", "system");
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
