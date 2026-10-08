const { normalizePhone } = require('../utils/dataQuality');
function duplicateGroups(leads, mode = 'phone', country = 'IN') {
  const parent = leads.map((_, i) => i), keys = new Map();
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  leads.forEach((lead, i) => {
    const values = [];
    try { values.push(normalizePhone(lead.phone, country)); } catch {}
    if (mode === 'phone_or_email' && lead.email?.trim()) values.push('email:' + lead.email.trim().toLowerCase());
    for (const key of values) {
      if (keys.has(key)) parent[find(i)] = find(keys.get(key));
      else keys.set(key, i);
    }
  });
  const groups = new Map();
  leads.forEach((lead, i) => { const root = find(i); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(lead); });
  return [...groups.values()].filter(g => g.length > 1).map(group => {
    group.sort((a,b) => +new Date(a.created_at) - +new Date(b.created_at) || a.id.localeCompare(b.id));
    return { norm_phone: group[0].id, leads: group };
  });
}
module.exports = { duplicateGroups };
