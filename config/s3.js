const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Readable } = require('stream');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: process.env.AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  } : undefined, // falls back to EC2 IAM role if no keys set
});

const BUCKET = process.env.S3_BUCKET_NAME;
const REGION = process.env.AWS_REGION || 'us-east-1';

const uploadToS3 = async (buffer, key, mimeType) => {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    ContentDisposition: 'inline',
  }));
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
};

const deleteFromS3 = async (fileUrl) => {
  if (!fileUrl || !fileUrl.includes('amazonaws.com')) return;
  const key = fileUrl.split('.amazonaws.com/')[1];
  if (key) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  }
};

const getPresignedUrl = async (fileUrl, expiresIn = 3600) => {
  if (!fileUrl || !fileUrl.includes('amazonaws.com')) return fileUrl;
  const key = fileUrl.split('.amazonaws.com/')[1];
  if (!key) return fileUrl;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
};

const downloadFromS3 = async (fileUrl) => {
  const key = fileUrl.split('.amazonaws.com/')[1]?.split('?')[0];
  if (!key) throw new Error('Invalid S3 URL');
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of response.Body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

module.exports = { uploadToS3, deleteFromS3, getPresignedUrl, downloadFromS3 };
