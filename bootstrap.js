const path = require('path');

// Every env var read anywhere in the codebase (verified via grep) with no safe
// in-code default — startup is meaningless without these. Keep in sync with
// new process.env.X reads added elsewhere in the app.
const REQUIRED_VARS = [
  'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
  'JWT_SECRET',
  'META_APP_ID', 'META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN',
  'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'EMAIL_FROM_ADDRESS', 'EMAIL_FROM_NAME', 'RESEND_API_KEY',
  'S3_BUCKET_NAME',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',
  'FRONTEND_URL', 'CORS_ALLOWED_ORIGINS',
];

// Names only in the log line — never values — so a missing-secret startup
// failure never leaks a partial secret into pm2 logs / CI output.
function validateRequiredVars() {
  const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }
}

// Pulls every parameter under /curvelead/production/ into process.env before
// anything else (db.js's eager pool, cryptoSecrets.js's eager key derivation,
// server.js's routes) gets a chance to require and read process.env while it's
// still empty. GetParametersByPathCommand caps MaxResults at 10 regardless of
// what's requested, so pagination via NextToken is mandatory here.
async function loadFromParameterStore() {
  const { SSMClient, GetParametersByPathCommand } = require('@aws-sdk/client-ssm');

  // The region needed to reach SSM can't itself come from SSM — this must
  // already be a real process-level env var (set in ecosystem.config.js) or
  // fall back to this hardcoded default.
  const region = process.env.AWS_REGION || 'ap-south-1';
  const ssm = new SSMClient({ region });
  const PARAM_PATH = '/curvelead/production/';

  let nextToken;
  try {
    do {
      const result = await ssm.send(new GetParametersByPathCommand({
        Path: PARAM_PATH,
        Recursive: true,
        WithDecryption: true,
        MaxResults: 10,
        NextToken: nextToken,
      }));

      for (const param of result.Parameters || []) {
        // '/curvelead/production/DB_HOST' -> 'DB_HOST' — flat, one segment per var
        const name = param.Name.slice(PARAM_PATH.length);
        process.env[name] = param.Value;
      }

      nextToken = result.NextToken;
    } while (nextToken);
  } catch (err) {
    console.error('❌ Failed to load parameters from AWS SSM Parameter Store:', err.message);
    process.exit(1);
  }
}

(async () => {
  if (process.env.NODE_ENV === 'production') {
    await loadFromParameterStore();
  } else {
    // Local dev only — production never touches .env, only Parameter Store.
    require('dotenv').config();
  }

  validateRequiredVars();

  // Requiring server.js here (not earlier) is the whole point of this file:
  // process.env is fully populated by this line, so db.js's eager pool creation
  // and cryptoSecrets.js's eager key derivation see real values, not undefined.
  require(path.join(__dirname, 'server'));
})();
