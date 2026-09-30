const crypto = require("crypto");
function verifyMetaWebhook(body, signature, secret) {
  if (
    !Buffer.isBuffer(body) ||
    typeof signature !== "string" ||
    !/^sha256=[a-f0-9]{64}$/i.test(signature) ||
    !secret
  )
    return false;
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  return crypto.timingSafeEqual(
    expected,
    Buffer.from(signature.slice(7), "hex"),
  );
}
module.exports = { verifyMetaWebhook };
