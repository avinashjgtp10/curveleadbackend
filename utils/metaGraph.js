const axios = require('axios');
const { GRAPH_URL } = require('../config/meta');

// Shared Meta Graph API client for the Ads module: reads Meta's usage headers,
// slows down before a throttle instead of after, and retries throttling and
// transient errors with exponential backoff.

// Graph error codes that mean "throttled / temporarily unavailable — retry later".
const THROTTLE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);
const TRANSIENT_CODES = new Set([1, 2]);

const safeJson = (value) => {
  if (!value) return null;
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
};

// Highest usage percentage across Meta's three usage headers, and how long Meta
// says to wait before access is regained (seconds).
const parseUsageHeaders = (headers = {}) => {
  const get = (name) => headers[name] ?? headers[name.toLowerCase()];
  let maxPct = 0, regainSeconds = 0;
  const bump = (pct) => { const n = Number(pct); if (Number.isFinite(n)) maxPct = Math.max(maxPct, n); };

  const buc = safeJson(get('x-business-use-case-usage'));
  if (buc && typeof buc === 'object') {
    for (const entries of Object.values(buc)) {
      for (const e of Array.isArray(entries) ? entries : []) {
        bump(e.call_count); bump(e.total_cputime); bump(e.total_time);
        const minutes = Number(e.estimated_time_to_regain_access);
        if (Number.isFinite(minutes)) regainSeconds = Math.max(regainSeconds, minutes * 60);
      }
    }
  }
  const account = safeJson(get('x-ad-account-usage'));
  if (account) {
    bump(account.acc_id_util_pct);
    const reset = Number(account.reset_time_duration);
    if (Number(account.acc_id_util_pct) >= 100 && Number.isFinite(reset)) regainSeconds = Math.max(regainSeconds, reset);
  }
  const app = safeJson(get('x-app-usage'));
  if (app) { bump(app.call_count); bump(app.total_cputime); bump(app.total_time); }

  return { maxPct, regainSeconds };
};

// How long to pause further calls for this key, given the latest usage.
const usageDelayMs = ({ maxPct, regainSeconds }) => {
  if (regainSeconds > 0) return regainSeconds * 1000;
  if (maxPct >= 95) return 120000;
  if (maxPct >= 90) return 60000;
  if (maxPct >= 75) return 10000;
  return 0;
};

const backoffMs = (attempt, base = 1000, cap = 300000) =>
  Math.min(cap, base * 2 ** attempt) + Math.floor(Math.random() * base);

class MetaGraphError extends Error {
  constructor(error = {}, status) {
    super(error.error_user_msg || error.message || 'Meta Graph API request failed.');
    this.name = 'MetaGraphError';
    this.code = error.code;
    this.subcode = error.error_subcode;
    this.type = error.type;
    this.fbtraceId = error.fbtrace_id;
    this.status = status;
  }
  get isThrottle() { return THROTTLE_CODES.has(this.code) || this.status === 429; }
  get isTransient() { return this.isThrottle || TRANSIENT_CODES.has(this.code) || this.status >= 500; }
  get isAuth() { return this.code === 190 || this.code === 102; }
}

// Per-key (usually ad account id) "don't call before" timestamps, in this process.
const gates = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {string} opts.path      e.g. "/act_123/insights" (leading slash)
 * @param {string} opts.token     access token (sent as a Bearer header, never in the URL)
 * @param {string} [opts.method]  GET by default
 * @param {object} [opts.params]  query params
 * @param {object} [opts.data]    POST body (sent as form fields, as Graph expects)
 * @param {string} [opts.gateKey] throttle bucket, e.g. the ad account id
 * @param {number} [opts.retries] max retries for throttling/transient errors
 */
const graphRequest = async ({ path, token, method = 'GET', params, data, gateKey = 'app', retries = 5, _sleep = sleep, _http = axios }) => {
  for (let attempt = 0; ; attempt++) {
    const wait = (gates.get(gateKey) || 0) - Date.now();
    if (wait > 0) await _sleep(wait);
    try {
      const url = path.startsWith('http') ? path : `${GRAPH_URL}${path}`;
      const body = data ? new URLSearchParams(Object.entries(data).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])) : undefined;
      const response = await _http.request({
        url, method, params, data: body, timeout: 60000,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      });
      const delay = usageDelayMs(parseUsageHeaders(response.headers));
      if (delay) gates.set(gateKey, Date.now() + delay);
      return response.data;
    } catch (e) {
      const err = e instanceof MetaGraphError ? e : new MetaGraphError(e.response?.data?.error || { message: e.message }, e.response?.status);
      if (e.response?.headers) {
        const delay = usageDelayMs(parseUsageHeaders(e.response.headers));
        if (delay) gates.set(gateKey, Date.now() + delay);
      }
      if (!err.isTransient || attempt >= retries) throw err;
      await _sleep(backoffMs(attempt));
    }
  }
};

// Follows paging.next until exhausted (or maxPages), returning every row.
const graphPaged = async (opts, maxPages = 200) => {
  const rows = [];
  let next = null, page = 0;
  do {
    const data = await graphRequest(next ? { ...opts, path: next, params: undefined } : opts);
    rows.push(...(data.data || []));
    next = data.paging?.next || null;
  } while (next && ++page < maxPages);
  return rows;
};

// Graph batch API: up to 50 relative requests per call. Returns parsed bodies in
// order; failed sub-requests come back as MetaGraphError instances (not thrown).
const graphBatch = async ({ token, requests, gateKey }) => {
  const out = [];
  for (let i = 0; i < requests.length; i += 50) {
    const chunk = requests.slice(i, i + 50).map((r) => ({ method: r.method || 'GET', relative_url: r.relative_url.replace(/^\//, '') }));
    const results = await graphRequest({ path: '/', method: 'POST', token, gateKey, data: { batch: chunk, include_headers: false } });
    for (const r of results || []) {
      const body = safeJson(r?.body);
      out.push(!r || r.code >= 400 ? new MetaGraphError(body?.error || { message: `Batch request failed (${r?.code})` }, r?.code) : body);
    }
  }
  return out;
};

module.exports = { graphRequest, graphPaged, graphBatch, parseUsageHeaders, usageDelayMs, backoffMs, MetaGraphError, _gates: gates };
