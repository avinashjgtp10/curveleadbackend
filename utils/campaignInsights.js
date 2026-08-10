// Rule-based "which campaign to focus on" verdicts. Compares each campaign against
// the tenant's own baseline (avg across its other campaigns with enough data) rather
// than fixed thresholds — what counts as "good" varies a lot by business.
const MIN_LEADS_FOR_VERDICT = 3;
const MIN_LEADS_FOR_BASELINE = 3;
const HIGH_DISQUALIFIED_RATE = 50; // flags a campaign outright, even without baseline data

// Which "quality" signal to judge by depends on what data actually exists yet:
// prefer won/conversion rate once the tenant has real wins, else fall back to
// (inverse) disqualification rate, else the AI hot-lead rate — each is progressively
// earlier in the funnel, so it's what's available before anything has converted.
const pickSignal = (withData) => {
  if (withData.some(c => parseFloat(c.conversion_rate) > 0)) {
    return { key: 'conversion', get: c => parseFloat(c.conversion_rate) };
  }
  if (withData.some(c => parseFloat(c.disqualified_rate) > 0)) {
    return { key: 'disqualified', get: c => 100 - parseFloat(c.disqualified_rate) };
  }
  return { key: 'hot', get: c => parseFloat(c.hot_rate) || 0 };
};

const describeQuality = (c, signal, avgQuality) => {
  const disqualified = parseFloat(c.disqualified_rate) || 0;
  if (signal.key === 'conversion') return `${c.conversion_rate}% convert (your avg is ${avgQuality.toFixed(1)}%)`;
  if (signal.key === 'disqualified') return `${disqualified.toFixed(1)}% got disqualified (your avg is ${(100 - avgQuality).toFixed(1)}%)`;
  return `${(parseFloat(c.hot_rate) || 0).toFixed(1)}% score as hot leads (your avg is ${avgQuality.toFixed(1)}%)`;
};

const rankCampaigns = (campaignsToAnnotate, baselineCampaigns = campaignsToAnnotate) => {
  const withData = baselineCampaigns.filter(c => c.total_leads >= MIN_LEADS_FOR_BASELINE);
  const signal = pickSignal(withData);
  const avgQuality = withData.length ? withData.reduce((sum, c) => sum + signal.get(c), 0) / withData.length : 0;
  const avgVolume = withData.length ? withData.reduce((sum, c) => sum + c.total_leads, 0) / withData.length : 0;

  return campaignsToAnnotate.map(c => {
    if (c.total_leads === 0) {
      return { ...c, verdict: 'no_leads', verdict_label: 'No leads yet', verdict_reason: "This campaign hasn't generated any leads yet." };
    }
    if (c.total_leads < MIN_LEADS_FOR_VERDICT) {
      return {
        ...c, verdict: 'too_early', verdict_label: 'Not enough data',
        verdict_reason: `Only ${c.total_leads} lead${c.total_leads === 1 ? '' : 's'} so far — too early to judge quality.`,
      };
    }

    const quality = signal.get(c);
    const disqualifiedRate = parseFloat(c.disqualified_rate) || 0;
    const isHighVolume = avgVolume > 0 && c.total_leads >= avgVolume * 1.2;
    const isLowVolume = avgVolume > 0 && c.total_leads <= avgVolume * 0.7;
    const isHighQuality = avgQuality > 0 ? quality >= avgQuality * 1.2 : quality > 0;
    const isLowQuality = avgQuality > 0 && quality <= avgQuality * 0.7;

    // A campaign disqualifying most of its leads is a red flag on its own, even
    // before there's enough tenant-wide data to compare against.
    const isBadOnItsOwn = disqualifiedRate >= HIGH_DISQUALIFIED_RATE;

    if (isHighVolume && (isLowQuality || isBadOnItsOwn)) {
      return {
        ...c, verdict: 'high_volume_low_quality', verdict_label: '⚠️ High volume, low quality',
        verdict_reason: `${c.total_leads} leads, but ${describeQuality(c, signal, avgQuality)} — most aren't panning out. Worth reviewing targeting before spending more here.`,
      };
    }
    if (isHighQuality && !isBadOnItsOwn) {
      return {
        ...c, verdict: 'high_quality', verdict_label: '🎯 High quality — worth more spend',
        verdict_reason: isHighVolume
          ? `${describeQuality(c, signal, avgQuality)}, and volume is already high — your best performer.`
          : `${describeQuality(c, signal, avgQuality)} — fewer leads, but much sharper. Consider increasing budget here.`,
      };
    }
    if (isLowVolume && (isLowQuality || isBadOnItsOwn)) {
      return {
        ...c, verdict: 'underperforming', verdict_label: '💤 Underperforming',
        verdict_reason: `Low volume (${c.total_leads} leads) and ${describeQuality(c, signal, avgQuality)}.`,
      };
    }
    return {
      ...c, verdict: 'average', verdict_label: '➖ On par',
      verdict_reason: `Performing roughly in line with your other campaigns.`,
    };
  });
};

module.exports = { rankCampaigns };
