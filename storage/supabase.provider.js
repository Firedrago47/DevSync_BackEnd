const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY 
);

const BUCKET = process.env.SUPABASE_BUCKET;

/**
 * PUT object
 */
async function putObject(key, body, contentType = "application/json") {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(key, body, {
      contentType,
      upsert: true, // overwrite if exists
    });

  if (error) throw error;
}

/**
 * GET object
 */
async function getObject(key) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .download(key);

  if (error) throw error;

  const buffer = Buffer.from(await data.arrayBuffer());
  return buffer.toString("utf-8");
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
