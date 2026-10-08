const axios = require("axios");
const { GRAPH_URL } = require('../config/meta');
function parseTier(value) {
  if (value === "TIER_UNLIMITED") return Number.MAX_SAFE_INTEGER;
  const match = /^(?:TIER_)?(\d+)(K)?$/.exec(String(value || ""));
  return match ? Number(match[1]) * (match[2] ? 1000 : 1) : null;
}
async function messagingLimit(credentials, configured) {
  let live = null;
  if (credentials?.phone_number_id && credentials?.access_token)
    try {
      const { data } = await axios.get(
        `${GRAPH_URL}/${encodeURIComponent(credentials.phone_number_id)}`,
        {
          params: { fields: "messaging_limit_tier" },
          headers: { Authorization: `Bearer ${credentials.access_token}` },
          timeout: 10000,
        },
      );
      live = parseTier(data.messaging_limit_tier);
    } catch {}
  const local =
    Number.isSafeInteger(Number(configured)) && Number(configured) > 0
      ? Number(configured)
      : null;
  if (!live && !local)
    throw new Error(
      "Messaging tier unavailable. Set the verified limit in Settings before broadcasting.",
    );
  return Math.min(live || Infinity, local || Infinity);
}
module.exports = { parseTier, messagingLimit };
