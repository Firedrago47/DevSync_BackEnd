const fs = require("fs/promises");
const path = require("path");

const ROOT = process.env.LOCAL_STORAGE_ROOT || "./.devsync-data";

function resolvePath(key) {
  return path.join(ROOT, key);
}

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function putObject(key, body) {
  const filePath = resolvePath(key);
  await ensureDir(filePath);
  await fs.writeFile(filePath, body);
}

async function getObject(key) {
  const filePath = resolvePath(key);
  return fs.readFile(filePath, "utf-8");
}

async function deleteObject(key) {
  const filePath = resolvePath(key);
  await fs.rm(filePath, { recursive: true, force: true });
}

module.exports = {
  putObject,
  getObject,
  deleteObject,
};
