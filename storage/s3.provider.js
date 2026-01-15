const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const client = new S3Client({
  region: process.env.STORAGE_REGION,
  endpoint: process.env.STORAGE_ENDPOINT, // IMPORTANT
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY,
    secretAccessKey: process.env.STORAGE_SECRET_KEY,
  },
  forcePathStyle: true, // REQUIRED for MinIO / some providers
});

const BUCKET = process.env.STORAGE_BUCKET;

async function putObject(key, body, contentType = "application/json") {
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

async function getObject(key) {
  const res = await client.send(
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );

  return streamToString(res.Body);
}

async function deleteObject(key) {
  await client.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );
}

// Helper
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf-8"))
    );
  });
}

module.exports = {
  putObject,
  getObject,
  deleteObject,
};
