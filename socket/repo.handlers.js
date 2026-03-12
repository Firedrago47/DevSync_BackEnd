const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const crypto = require("crypto");
const Y = require("yjs");
const storage = require("../storage");
const roomService = require("../storage/room.service");
const { getRoom, saveTree, saveYDoc } = require("./state");

const MAX_REPO_FILES = Number(process.env.REPO_IMPORT_MAX_FILES || 400);
const MAX_FILE_BYTES = Number(process.env.REPO_IMPORT_MAX_FILE_BYTES || 512000);
const CLONE_TIMEOUT_MS = Number(process.env.REPO_IMPORT_TIMEOUT_MS || 120000);

function isDirectoryEntryHidden(name) {
  return name === ".git" || name === "node_modules" || name.startsWith(".next");
}

function looksLikeBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

function buildPath(parentPath, name) {
  if (!parentPath || parentPath === "/") return `/${name}`;
  return `${parentPath}/${name}`;
}

function normalizeRepoUrl(url) {
  if (typeof url !== "string") return "";
  return url.trim();
}

function cloneRepo(repoUrl, targetDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["clone", "--depth", "1", repoUrl, targetDir],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Clone timed out after ${CLONE_TIMEOUT_MS}ms`));
    }, CLONE_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (err && err.code === "ENOENT") {
        reject(
          new Error(
            "Git is not installed on the server environment (spawn git ENOENT). Install git in deployment image."
          )
        );
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = stderr || stdout || `git clone failed (exit=${code})`;
        reject(new Error(detail.trim()));
      }
    });
  });
}

async function buildTreeAndDocs(rootDir) {
  const tree = [];
  const docs = [];
  let fileCount = 0;

  async function walk(currentPath, parentId, parentVirtualPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (isDirectoryEntryHidden(entry.name)) continue;

      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        const folderId = crypto.randomUUID();
        const folderVirtualPath = buildPath(parentVirtualPath, entry.name);
        tree.push({
          id: folderId,
          name: entry.name,
          type: "folder",
          parentId,
          path: folderVirtualPath,
          updatedAt: Date.now(),
        });
        await walk(entryPath, folderId, folderVirtualPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (fileCount >= MAX_REPO_FILES) continue;

      const stat = await fs.stat(entryPath);
      if (stat.size > MAX_FILE_BYTES) continue;

      const buffer = await fs.readFile(entryPath);
      if (looksLikeBinary(buffer)) continue;

      const source = buffer.toString("utf-8");
      const fileId = crypto.randomUUID();
      const fileVirtualPath = buildPath(parentVirtualPath, entry.name);

      tree.push({
        id: fileId,
        name: entry.name,
        type: "file",
        parentId,
        path: fileVirtualPath,
        updatedAt: Date.now(),
      });

      docs.push({
        fileId,
        source,
      });
      fileCount += 1;
    }
  }

  await walk(rootDir, null, "/");
  return { tree, docs, fileCount };
}

function registerRepoHandlers(io, socket) {
  socket.on("repo:clone", async (payload, ack) => {
    const respond = typeof ack === "function" ? ack : () => {};

    try {
      const roomId = payload?.roomId;
      const repoUrl = normalizeRepoUrl(payload?.repoUrl);

      if (typeof roomId !== "string" || !roomId) {
        respond({ ok: false, error: "roomId is required" });
        return;
      }

      if (!repoUrl) {
        respond({ ok: false, error: "repoUrl is required" });
        return;
      }

      const member = await roomService.isMember(roomId, socket.userId);
      if (!member || member.role === "viewer") {
        socket.emit("room:error", {
          roomId,
          code: "forbidden",
          message: "You are not allowed to import repositories in this room",
        });
        respond({ ok: false, error: "forbidden" });
        return;
      }

      if (!socket.rooms.has(roomId)) {
        respond({ ok: false, error: "join room first" });
        return;
      }

      const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-clone-"));
      const cloneDir = path.join(tempBase, "repo");

      try {
        await cloneRepo(repoUrl, cloneDir);
        const { tree, docs, fileCount } = await buildTreeAndDocs(cloneDir);

        const room = await getRoom(roomId);
        room.tree = tree;
        room.docs.clear();
        await saveTree(roomId, tree);

        for (const file of docs) {
          const doc = new Y.Doc();
          doc.getText("content").insert(0, file.source);
          room.docs.set(file.fileId, doc);
          await saveYDoc(roomId, file.fileId, doc);
        }

        io.to(roomId).emit("fs:snapshot", {
          roomId,
          nodes: tree,
        });

        respond({
          ok: true,
          importedFiles: fileCount,
          totalNodes: tree.length,
        });
      } finally {
        await fs.rm(tempBase, { recursive: true, force: true }).catch(() => {});
      }
    } catch (err) {
      console.error("repo:clone failed:", err);
      respond({
        ok: false,
        error: err?.message || "Failed to clone repository",
      });
    }
  });
}

module.exports = registerRepoHandlers;
