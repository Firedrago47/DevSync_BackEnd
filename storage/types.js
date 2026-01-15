/**
 * StorageProvider interface
 *
 * All providers MUST implement these
 */
module.exports = {
  putObject: async (key, body, contentType) => {},
  getObject: async (key) => {},
  deleteObject: async (key) => {},
};
