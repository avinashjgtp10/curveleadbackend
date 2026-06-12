const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

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

module.exports = { uploadToS3, deleteFromS3 };
