const { createClient } = require("@supabase/supabase-js");

/* ---------- Env validation ---------- */
if (!process.env.SUPABASE_URL) {
  throw new Error("SUPABASE_URL is not set");
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
}

if (!process.env.SUPABASE_BUCKET) {
  throw new Error("SUPABASE_BUCKET is not set");
}

/* ---------- Client ---------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = process.env.SUPABASE_BUCKET;

/* ---------- Helpers ---------- */

/**
 * PUT object (create or overwrite)
 */
async function putObject(
  key,
  body,
  contentType = "application/octet-stream"
) {
  // Try update first (overwrite)
  const { error: updateErr } = await supabase.storage
    .from(BUCKET)
    .update(key, body, { contentType });

  // If file does not exist, upload
  if (updateErr) {
    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(key, body, {
        contentType,
        upsert: false,
      });

    if (uploadErr) throw uploadErr;
  }
}

/**
 * GET object
 * Returns Buffer (NOT string)
 */
async function getObject(key) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .download(key);

  if (error) throw error;

  return Buffer.from(await data.arrayBuffer());
}

/**
 * DELETE object
 */
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
