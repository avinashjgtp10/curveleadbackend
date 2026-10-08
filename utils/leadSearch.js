// Build parameterized predicates only; the caller supplies tenant/staff/filter scope.
const escapeLike = value => value.replace(/[\\%_]/g, '\\$&');
function buildLeadSearch(value, firstParameter) {
  if (typeof value !== 'string') return null;
  const term = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!term) return null;
  if (term.length > 200) throw Object.assign(new Error('Search must be 200 characters or fewer.'), { status: 422 });
  const digits = /^[+\d\s().-]+$/.test(term) ? term.replace(/\D/g, '') : '';
  const p = n => `$${firstParameter + n}`;
  const name = 'public.curvelead_search_text(l.name)';
  const id = "lower(COALESCE(l.lead_number::text, ''))";
  const phone = "regexp_replace(COALESCE(l.phone,''), '[^0-9]', '', 'g')";
  const exact = `(${name} = public.curvelead_search_text(${p(0)}) OR ${id} = lower(${p(0)}) OR l.id::text = lower(${p(0)}) OR (${p(3)} <> '' AND ${phone} = ${p(3)}))`;
  const prefix = `(${name} LIKE public.curvelead_search_text(${p(1)}) ESCAPE '\\' OR ${id} LIKE lower(${p(1)}) ESCAPE '\\')`;
  const direct = `(${name} LIKE public.curvelead_search_text(${p(2)}) ESCAPE '\\' OR ${id} LIKE lower(${p(2)}) ESCAPE '\\' OR l.id::text = lower(${p(0)}) OR (${p(3)} <> '' AND ${phone} LIKE '%' || ${p(3)}))`;
  const allowFuzzy = !digits && !/^ld[-\s]?\d/i.test(term) && /^\p{L}[\p{L}\p{M}\s'-]{3,}$/u.test(term);
  return {
    values: [term, `${escapeLike(term)}%`, `%${escapeLike(term)}%`, digits],
    direct: `(${direct} AND ${p(1)}::text IS NOT NULL)`,
    rank: `CASE WHEN ${exact} THEN 0 WHEN ${prefix} THEN 1 ELSE 2 END`,
    // A deliberately conservative word threshold; phone/ID searches never use fuzzy matching.
    fuzzy: allowFuzzy ? `public.strict_word_similarity(public.curvelead_search_text(${p(0)}), ${name}) >= 0.6 AND ${p(1)}::text IS NOT NULL AND ${p(2)}::text IS NOT NULL AND ${p(3)}::text IS NOT NULL` : null,
    fuzzyRank: `public.strict_word_similarity(public.curvelead_search_text(${p(0)}), ${name}) DESC`,
  };
}
module.exports = { buildLeadSearch };
