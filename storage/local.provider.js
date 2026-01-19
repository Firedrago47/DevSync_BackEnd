// storage.js - Simple file system storage
const fs = require("fs").promises;
const path = require("path");

const STORAGE_DIR = path.join(__dirname, "storage");

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {}
}

async function getObject(key) {
  const filePath = path.join(STORAGE_DIR, key);
  return await fs.readFile(filePath, "utf-8");
}

async function putObject(key, data, contentType) {
  const filePath = path.join(STORAGE_DIR, key);
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, data, "utf-8");
}

module.exports = { getObject, putObject };