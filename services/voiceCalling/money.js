// Integer-only money math for CurveLead Voice. Never use JS floats for settlement.
//   minor units  = paise / fils / cents (wallet balances, charges)  -> BigInt in code, BIGINT in SQL
//   micro rates  = millionths of the MAJOR currency per minute      -> 1 INR/min = 1_000_000
// 1 minor unit = 10_000 micro-units (2-decimal currencies).
const MICRO_PER_MINOR = 10000n;

const big = (v) => (typeof v === 'bigint' ? v : BigInt(v ?? 0));
const ceilDiv = (a, b) => (a + b - 1n) / b; // a >= 0, b > 0

const roundUpToIncrement = (seconds, increment) => {
  const s = big(seconds); const inc = big(increment);
  if (s <= 0n) return 0n;
  return ceilDiv(s, inc) * inc;
};

// Charge in minor units for `seconds` of talk time. Rounds UP to the billing increment, then up to the next minor unit.
const chargeMinor = (seconds, ratePerMinuteMicro, incrementSeconds = 60) => {
  const billable = roundUpToIncrement(seconds, incrementSeconds);
  if (billable === 0n) return 0n;
  const micro = ceilDiv(billable * big(ratePerMinuteMicro), 60n);
  return ceilDiv(micro, MICRO_PER_MINOR);
};

// Longest duration (a multiple of the increment) whose charge fits within `availableMinor`. null = unlimited (free route).
const affordableSeconds = (availableMinor, ratePerMinuteMicro, incrementSeconds = 60) => {
  const rate = big(ratePerMinuteMicro);
  if (rate === 0n) return null;
  const avail = big(availableMinor);
  if (avail <= 0n) return 0n;
  const raw = (avail * MICRO_PER_MINOR * 60n) / rate;
  const inc = big(incrementSeconds);
  return (raw / inc) * inc;
};

// Selling price from provider cost with a markup in basis points (1500 = 15%). Rounds up.
const applyMarkupBps = (costMicro, markupBps) => ceilDiv(big(costMicro) * (10000n + big(markupBps)), 10000n);

// Human display only (never feed back into arithmetic).
const formatMinor = (minor, currency) => `${currency} ${(Number(big(minor)) / 100).toFixed(2)}`;
const formatRateMicro = (micro, currency) => `${currency} ${(Number(big(micro)) / 1e6).toFixed(4)}/min`;

module.exports = { big, chargeMinor, affordableSeconds, applyMarkupBps, roundUpToIncrement, formatMinor, formatRateMicro, MICRO_PER_MINOR };
