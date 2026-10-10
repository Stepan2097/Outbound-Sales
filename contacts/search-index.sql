-- Apply to the CRM database before releasing the RPC caller. Additive only:
-- contacts and CRM row-level security policies are not changed.
-- Run as the database migration role, outside a surrounding transaction:
-- concurrent indexes avoid blocking the CRM's contact writes.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
SET search_path = pg_catalog, public, extensions;

-- Supabase normally installs unaccent in extensions; resolve an existing
-- installation as well rather than moving an extension used by the CRM.
DO $migration$
DECLARE ext_schema text;
BEGIN
  SELECT n.nspname INTO ext_schema FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'unaccent';
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION public.outbound_search_normalize(value text)
    RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $body$ BEGIN RETURN pg_catalog.lower(pg_catalog.btrim(%I.unaccent(%L::regdictionary, coalesce(value, '')))); END $body$
  $definition$, ext_schema, ext_schema || '.unaccent');
END
$migration$;

CREATE OR REPLACE FUNCTION public.outbound_search_document(name text, company text, email text, job_title text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN public.outbound_search_normalize(coalesce(name, '') || E'\n' || coalesce(company, '') || E'\n' || coalesce(email, '') || E'\n' || coalesce(job_title, ''));

-- The legacy fuzzy match uses word bigrams. This additional candidate index
-- keeps its recall even for typos with no shared trigrams (abc -> bca).
CREATE OR REPLACE FUNCTION public.outbound_search_bigrams(value text)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT coalesce(array_agg(DISTINCT substr(word, at, 2)), ARRAY[]::text[])
  FROM regexp_split_to_table(value, '[[:space:]@._-]+') AS words(word)
  CROSS JOIN LATERAL generate_series(1, length(word) - 1) AS positions(at)
$function$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS outbound_contacts_folder_order_idx
  ON public.contacts (folder_id, created_at, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS outbound_contacts_search_trgm_idx
  ON public.contacts USING gin (public.outbound_search_document(name, company, email, position) gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS outbound_contacts_search_bigrams_idx
  ON public.contacts USING gin (public.outbound_search_bigrams(public.outbound_search_document(name, company, email, position)));

CREATE OR REPLACE FUNCTION public.outbound_search_word_similarity(left_word text, right_word text)
RETURNS double precision LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE a text[] := ARRAY[]::text[]; b text[] := ARRAY[]::text[]; gram text; common integer := 0; at integer;
BEGIN
  IF left_word = right_word THEN RETURN 1; END IF;
  IF length(left_word) < 3 OR length(right_word) < 3 THEN RETURN 0; END IF;
  FOR at IN 1..length(left_word) - 1 LOOP
    gram := substr(left_word, at, 2);
    IF NOT gram = ANY(a) THEN
      a := array_append(a, gram);
      IF strpos(right_word, gram) > 0 THEN common := common + 1; END IF;
    END IF;
  END LOOP;
  IF common = 0 THEN RETURN 0; END IF;
  FOR at IN 1..length(right_word) - 1 LOOP
    gram := substr(right_word, at, 2);
    IF NOT gram = ANY(b) THEN b := array_append(b, gram); END IF;
  END LOOP;
  RETURN 2.0 * common / (cardinality(a) + cardinality(b));
END
$function$;

CREATE OR REPLACE FUNCTION public.outbound_search_contacts(p_folder_id uuid, p_search text)
RETURNS SETOF public.contacts LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, extensions
SET statement_timeout = '5s'
-- Prefixes, rare typos and one-character queries have very different index
-- selectivity; a generic PL/pgSQL plan can turn the sixth search into a scan.
SET plan_cache_mode = 'force_custom_plan'
SET enable_seqscan = 'off'
SET jit = 'off'
AS $function$
DECLARE term text := public.outbound_search_normalize(left(btrim(p_search), 120));
        pattern text; tokens text[]; grams text[]; short_patterns text[]; direct public.contacts[];
BEGIN
  IF p_folder_id IS NULL OR term = '' THEN RETURN; END IF;
  pattern := '%' || replace(replace(replace(term, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  tokens := regexp_split_to_array(term, '[[:space:]]+');
  grams := ARRAY(SELECT DISTINCT substr(term, at, 2) FROM generate_series(1, length(term) - 1) at);
  short_patterns := ARRAY(SELECT '%' || replace(replace(replace(token, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%'
    FROM unnest(tokens) token WHERE length(token) < 3);
  -- A substring always outranks a fuzzy match. Common name prefixes therefore
  -- finish using only the trigram candidates, without scoring similar words.
  SELECT array_agg(c ORDER BY score DESC, (c).id ASC) INTO direct FROM (
    SELECT c, (
      SELECT max(CASE WHEN field = term THEN 100 WHEN starts_with(field, term) THEN 90 WHEN strpos(field, term) > 0 THEN 80 ELSE 0 END)
      FROM unnest(ARRAY[public.outbound_search_normalize(c.name), public.outbound_search_normalize(c.company),
        public.outbound_search_normalize(c.email), public.outbound_search_normalize(c.position)]) f(field)
    ) AS score
    FROM public.contacts c
    WHERE c.folder_id = p_folder_id AND public.outbound_search_document(c.name, c.company, c.email, c.position) LIKE pattern ESCAPE E'\\'
    ORDER BY score DESC, c.id ASC LIMIT 5
  ) matches WHERE score > 0;
  IF cardinality(direct) = 5 THEN
    RETURN QUERY SELECT d.* FROM unnest(direct) d;
    RETURN;
  END IF;
  RETURN QUERY
  WITH candidate_ids AS MATERIALIZED (
    SELECT id FROM public.contacts c WHERE c.folder_id = p_folder_id
      AND public.outbound_search_document(c.name, c.company, c.email, c.position) LIKE pattern ESCAPE E'\\'
    UNION
    SELECT id FROM public.contacts c WHERE c.folder_id = p_folder_id
      AND public.outbound_search_bigrams(public.outbound_search_document(c.name, c.company, c.email, c.position)) && grams
    UNION
    SELECT id FROM public.contacts c WHERE c.folder_id = p_folder_id AND cardinality(short_patterns) > 0
      AND public.outbound_search_document(c.name, c.company, c.email, c.position) LIKE ANY(short_patterns)
  ), candidates AS MATERIALIZED (
    SELECT c,
      ARRAY[public.outbound_search_normalize(c.name), public.outbound_search_normalize(c.company),
            public.outbound_search_normalize(c.email), public.outbound_search_normalize(c.position)] AS fields
    FROM candidate_ids ids JOIN public.contacts c ON c.id = ids.id
  ), field_words AS MATERIALIZED (
    SELECT (c).id AS contact_id, f.field_id, word,
      CASE WHEN field = term THEN 100 WHEN starts_with(field, term) THEN 90 WHEN strpos(field, term) > 0 THEN 80 ELSE 0 END AS direct_score
    FROM candidates
    CROSS JOIN LATERAL unnest(fields) WITH ORDINALITY f(field, field_id)
    CROSS JOIN LATERAL regexp_split_to_table(field, '[[:space:]@._-]+') words(word)
  ), words AS MATERIALIZED (
    SELECT DISTINCT word FROM field_words WHERE direct_score = 0
  ), word_scores AS MATERIALIZED (
    -- Repeated names and titles occur thousands of times in an imported
    -- folder. Score each distinct word once, rather than once per contact.
    SELECT word, t.token_id, CASE WHEN strpos(word, token) > 0 THEN 1
      ELSE public.outbound_search_word_similarity(token, word) END AS score
    FROM words CROSS JOIN unnest(tokens) WITH ORDINALITY t(token, token_id)
  ), field_token_scores AS MATERIALIZED (
    SELECT contact_id, field_id, token_id, max(score) AS score
    FROM field_words JOIN word_scores USING (word)
    WHERE direct_score = 0 AND score >= 0.5
    GROUP BY contact_id, field_id, token_id
  ), scores AS (
    SELECT contact_id, max(direct_score)::double precision AS score FROM field_words
      WHERE direct_score > 0 GROUP BY contact_id
    UNION ALL
    SELECT contact_id, 60 * avg(score) AS score FROM field_token_scores
      GROUP BY contact_id, field_id HAVING count(*) = cardinality(tokens)
  ), ranked AS (
    SELECT contact_id, max(score) AS score FROM scores GROUP BY contact_id
  )
  SELECT (c).* FROM candidates JOIN ranked ON (c).id = contact_id
    WHERE score > 0 ORDER BY score DESC, contact_id ASC LIMIT 5;
END
$function$;

-- SECURITY INVOKER preserves the caller's table privileges/RLS. Only the
-- server-side CRM role can invoke the endpoint; no public or signed-in grant.
REVOKE ALL ON FUNCTION public.outbound_search_contacts(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbound_search_contacts(uuid, text) TO service_role;
ANALYZE public.contacts;
NOTIFY pgrst, 'reload schema';
