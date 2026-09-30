BEGIN;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
-- The fixed dictionary makes this safe to index. Reindex if its rules change.
CREATE OR REPLACE FUNCTION public.curvelead_search_text(value text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT lower(public.unaccent('public.unaccent'::regdictionary,
   regexp_replace(trim(normalize(COALESCE(value, ''), NFKC)), '[[:space:]]+', ' ', 'g')))
$$;
CREATE INDEX IF NOT EXISTS idx_leads_name_search_trgm
 ON leads USING gin (public.curvelead_search_text(name) public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_leads_phone_digits_search_trgm
 ON leads USING gin (regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_leads_number_search_trgm
 ON leads USING gin (lower(COALESCE(lead_number::text,'')) public.gin_trgm_ops);
COMMIT;
