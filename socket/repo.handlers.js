const fsp = require("fs/promises");
const nodeFs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const git = require("isomorphic-git");
const http = require("isomorphic-git/http/node");
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
  const cloneTask = git.clone({
    fs: nodeFs,
    http,
    dir: targetDir,
    url: repoUrl,
    singleBranch: true,
    depth: 1,
  });

  const timeoutTask = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Clone timed out after ${CLONE_TIMEOUT_MS}ms`));
    }, CLONE_TIMEOUT_MS);
  });

  return Promise.race([cloneTask, timeoutTask]);
}

async function buildTreeAndDocs(rootDir) {
  const tree = [];
  const docs = [];
  let fileCount = 0;

  async function walk(currentPath, parentId, parentVirtualPath) {
    const entries = await fsp.readdir(currentPath, { withFileTypes: true });
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

      const stat = await fsp.stat(entryPath);
      if (stat.size > MAX_FILE_BYTES) continue;

      const buffer = await fsp.readFile(entryPath);
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

      const tempBase = await fsp.mkdtemp(path.join(os.tmpdir(), "devsync-clone-"));
      const cloneDir = path.join(tempBase, "repo");

      try {
        await fsp.mkdir(cloneDir, { recursive: true });
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
        await fsp.rm(tempBase, { recursive: true, force: true }).catch(() => {});
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
