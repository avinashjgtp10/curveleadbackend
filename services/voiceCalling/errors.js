const util = require('util');
// Always returns something useful to log, whatever was thrown (Error, string, plain object, undefined).
// Stack/message only for Errors: never request bodies, headers or SQL parameters.
const describeError = (e) => {
  if (e instanceof Error) return e.stack || `${e.name}: ${e.message}`;
  if (e === undefined || e === null) return String(e);
  if (typeof e === 'string') return e.slice(0, 500);
  return util.inspect(e, { depth: 1, breakLength: Infinity }).slice(0, 500);
};
// "POST /api/voice/calls" for log lines. Never throws and never includes the query string.
const where = (req) => `${req?.method || '?'} ${String(req?.originalUrl || req?.url || '').split('?')[0]}`;
module.exports = { describeError, where };
