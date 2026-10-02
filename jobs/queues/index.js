// Job runner for the Ads/Social modules.
// With REDIS_URL set, jobs run on BullMQ (retries, backoff, delayed and repeatable
// jobs, survives restarts). Without it, the same handlers run in-process: repeat
// jobs on setInterval and one-off jobs immediately with the same retry policy —
// so the app works before Redis is provisioned, just without persistence.

const handlers = new Map();   // name -> { fn, attempts, backoffMs, concurrency }
const DEFAULTS = { attempts: 5, backoffMs: 30000, concurrency: 1 };
let bull = null;              // { connection, queues: Map, workers: [] }
let started = false;

const usingRedis = () => !!process.env.REDIS_URL;

const register = (name, fn, opts = {}) => handlers.set(name, { fn, ...DEFAULTS, ...opts });

// BullMQ needs ':'-free queue names; one queue per job name keeps concurrency separate.
const queueName = (name) => `curvelead-${name.replace(/[^a-z0-9-]/gi, '-')}`;

const getQueue = (name) => {
  const { Queue } = require('bullmq');
  if (!bull.queues.has(name)) bull.queues.set(name, new Queue(queueName(name), { connection: bull.connection }));
  return bull.queues.get(name);
};

// In-process fallback: same retry/backoff semantics, no persistence.
const runLocal = async (name, data, attempt = 0) => {
  const h = handlers.get(name);
  try {
    await h.fn(data, { attempt });
  } catch (e) {
    console.error(`[jobs] ${name} failed (attempt ${attempt + 1}/${h.attempts}):`, e.message);
    if (attempt + 1 < h.attempts) setTimeout(() => runLocal(name, data, attempt + 1), h.backoffMs * 2 ** attempt).unref?.();
  }
};
const localRunning = new Set();

/** Enqueue a one-off job. `jobId` de-duplicates while a job with that id is pending. */
const enqueue = async (name, data = {}, { jobId, delayMs } = {}) => {
  const h = handlers.get(name);
  if (!h) throw new Error(`No job handler registered for ${name}`);
  if (bull) {
    return getQueue(name).add(name, data, {
      jobId, delay: delayMs, attempts: h.attempts,
      backoff: { type: 'exponential', delay: h.backoffMs },
      removeOnComplete: 1000, removeOnFail: 5000,
    });
  }
  const key = jobId ? `${name}:${jobId}` : null;
  if (key && localRunning.has(key)) return null;
  if (key) localRunning.add(key);
  const run = () => runLocal(name, data).finally(() => key && localRunning.delete(key));
  if (delayMs) setTimeout(run, delayMs).unref?.(); else setImmediate(run);
  return null;
};

const repeats = [];
/** Run `name` every `everyMs` (first run after `firstDelayMs`). Call before start(). */
const repeat = (name, everyMs, data = {}, firstDelayMs = 60000) => repeats.push({ name, everyMs, data, firstDelayMs });

const start = async () => {
  if (started) return;
  started = true;
  if (usingRedis()) {
    try {
      const IORedis = require('ioredis');
      const { Worker } = require('bullmq');
      const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
      bull = { connection, queues: new Map(), workers: [] };
      for (const [name, h] of handlers) {
        const worker = new Worker(queueName(name), (job) => h.fn(job.data, { attempt: job.attemptsMade }), { connection, concurrency: h.concurrency });
        worker.on('failed', (job, err) => console.error(`[jobs] ${name} failed (attempt ${job?.attemptsMade}):`, err.message));
        bull.workers.push(worker);
      }
      for (const r of repeats) {
        await getQueue(r.name).upsertJobScheduler(`${r.name}-every`, { every: r.everyMs }, { name: r.name, data: r.data });
      }
      console.log(`✅ Job queues on Redis (${handlers.size} job types)`);
      return;
    } catch (e) {
      console.error('❌ Redis job queues unavailable, running jobs in-process:', e.message);
      bull = null;
    }
  }
  for (const r of repeats) {
    setTimeout(() => enqueue(r.name, r.data, { jobId: 'repeat' }), r.firstDelayMs).unref?.();
    setInterval(() => enqueue(r.name, r.data, { jobId: 'repeat' }), r.everyMs).unref?.();
  }
  console.log(`ℹ️  Job queues in-process (no REDIS_URL): ${handlers.size} job types`);
};

module.exports = { register, enqueue, repeat, start, usingRedis, _handlers: handlers };
