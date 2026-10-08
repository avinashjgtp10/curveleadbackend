const queues = require('./queues');
const { publishPost, sweep } = require('../services/social/publisher');

// Social posting jobs (Phase 6). social:publish runs at each post's time (a delayed
// BullMQ job with Redis); social:sweep runs every minute as the safety net — it queues
// anything due that a restart lost and releases posts stuck mid-publish.
const registerSocialJobs = () => {
  // Retries are handled per target inside publishPost, so the job itself runs once.
  queues.register('social:publish', (data) => publishPost(data), { attempts: 1, concurrency: 3 });
  queues.register('social:sweep', () => sweep(), { attempts: 1 });
  queues.repeat('social:sweep', 60 * 1000, {}, 45 * 1000);
};

module.exports = { registerSocialJobs };
