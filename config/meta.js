// The one place the Meta Graph API version is set. Bump META_GRAPH_VERSION (or the
// default here) after checking Meta's changelog for the endpoints we call.
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

module.exports = { GRAPH_VERSION, GRAPH_URL };
