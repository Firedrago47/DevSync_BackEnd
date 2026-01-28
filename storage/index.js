const provider = process.env.STORAGE_PROVIDER || "local";

switch (provider) {
  case "s3":
    module.exports = require("./s3.provider");
    break;
  case "supabase":
    module.exports = require("./supabase.provider");
    break;
  case "local":
  default:
    module.exports = require("./local.provider");
}
