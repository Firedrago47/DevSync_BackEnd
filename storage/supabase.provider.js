// storage/supabase.provider.js
const { createClient } = require("@supabase/supabase-js");

/* ---------- Env validation ---------- */
if (!process.env.SUPABASE_URL) {
  throw new Error("SUPABASE_URL missing");
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
}

if (!process.env.SUPABASE_BUCKET) {
  throw new Error("SUPABASE_BUCKET missing");
}

/* ---------- Client ---------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = process.env.SUPABASE_BUCKET;

/* ---------- PUT ---------- */
async function putObject(
  key,
  body,
  contentType = "application/octet-stream"
) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(key, body, {
      upsert: true,
      contentType,
    });

  if (error) throw error;
}

/* ---------- GET ---------- */
async function getObject(key) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .download(key);

  if (error) throw error;

  return Buffer.from(await data.arrayBuffer());
}

/* ---------- DELETE ---------- */
async function deleteObject(key) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .remove([key]);

  if (error) throw error;
}

module.exports = {
  putObject,
  getObject,
  deleteObject,
};
