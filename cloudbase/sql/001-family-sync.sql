-- Incremental, repeatable migration for this application's three tables only.
-- Run as the CloudBase SQL administrator; never ship service_role keys to clients.
-- RPC contract: get => {document}, list => {documents}, commit => {committed,...}.
-- Official security notes: https://docs.cloudbase.net/database/postgresql/rpc
-- Advisory transactions: https://www.postgresql.org/docs/current/explicit-locking.html
BEGIN;

CREATE TABLE IF NOT EXISTS public.summer_pet_config (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object' AND NOT body ? '_id')
);
CREATE TABLE IF NOT EXISTS public.summer_pet_events (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object' AND NOT body ? '_id')
);
CREATE TABLE IF NOT EXISTS public.summer_pet_device_requests (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object' AND NOT body ? '_id')
);

CREATE INDEX IF NOT EXISTS summer_pet_events_timestamp_id_idx
  ON public.summer_pet_events ((body->>'timestamp') COLLATE "C", id COLLATE "C");

ALTER TABLE public.summer_pet_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.summer_pet_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.summer_pet_device_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.summer_pet_config, public.summer_pet_events,
  public.summer_pet_device_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.summer_pet_config,
  public.summer_pet_events, public.summer_pet_device_requests TO service_role;
-- No client policies: default-deny RLS, plus table-level revocation. CloudBase's
-- server service_role has BYPASSRLS; administrators retain administrative access.

CREATE OR REPLACE FUNCTION public.summer_pet_get(p_table text, p_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_body jsonb;
BEGIN
  -- CloudBase RPC endpoints do not enforce EXECUTE privileges. Check the signed
  -- gateway role explicitly, including missing/NULL claims. A direct SQL call
  -- without JWT claims is allowed only for service_role or a privileged SQL
  -- administrator (SUPERUSER/BYPASSRLS), never based on an admin name prefix.
  IF v_claims IS NOT NULL THEN
    IF (v_claims::jsonb->>'role') IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'Family RPC requires server authorization' USING ERRCODE = '42501';
    END IF;
  ELSIF current_user IS DISTINCT FROM 'service_role'
    AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Family RPC requires server authorization' USING ERRCODE = '42501';
  END IF;
  IF p_table IS NULL OR p_table NOT IN
    ('summer_pet_config', 'summer_pet_events', 'summer_pet_device_requests') THEN
    RAISE EXCEPTION 'Unsupported family table' USING ERRCODE = '22023';
  END IF;
  IF p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'Invalid document ID' USING ERRCODE = '22023';
  END IF;
  EXECUTE format('SELECT body FROM public.%I WHERE id = $1', p_table)
    INTO v_body USING p_id;
  RETURN jsonb_build_object('document', v_body);
END;
$function$;

CREATE OR REPLACE FUNCTION public.summer_pet_list(
  p_table text, p_order text DEFAULT '_id',
  p_offset integer DEFAULT 0, p_limit integer DEFAULT 100
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_order text;
  v_documents jsonb;
BEGIN
  IF v_claims IS NOT NULL THEN
    IF (v_claims::jsonb->>'role') IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'Family RPC requires server authorization' USING ERRCODE = '42501';
    END IF;
  ELSIF current_user IS DISTINCT FROM 'service_role'
    AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Family RPC requires server authorization' USING ERRCODE = '42501';
  END IF;
  IF p_table IS NULL OR p_table NOT IN
    ('summer_pet_config', 'summer_pet_events', 'summer_pet_device_requests') THEN
    RAISE EXCEPTION 'Unsupported family table' USING ERRCODE = '22023';
  END IF;
  IF p_order IS NULL OR p_order NOT IN ('_id', 'timestamp_id')
    OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 100000
    OR p_limit IS NULL OR p_limit NOT BETWEEN 0 AND 1000 THEN
    RAISE EXCEPTION 'Invalid family page arguments' USING ERRCODE = '22023';
  END IF;
  v_order := CASE p_order
    WHEN 'timestamp_id' THEN '(body->>''timestamp'') COLLATE "C" ASC NULLS LAST, id COLLATE "C" ASC'
    ELSE 'id COLLATE "C" ASC' END;
  -- Only the whitelisted identifier and one of two constant order clauses are
  -- interpolated. IDs, bodies, offsets and limits are always bound parameters.
  EXECUTE format(
    'SELECT coalesce(jsonb_agg(record ORDER BY ordinal), ''[]''::jsonb)
       FROM (SELECT body || jsonb_build_object(''_id'', id) AS record,
                    row_number() OVER (ORDER BY %s) AS ordinal
               FROM public.%I ORDER BY %s OFFSET $1 LIMIT $2) AS page',
    v_order, p_table, v_order)
    INTO v_documents USING p_offset, p_limit;
  RETURN jsonb_build_object('documents', v_documents);
END;
$function$;

CREATE OR REPLACE FUNCTION public.summer_pet_commit(p_reads jsonb, p_writes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_item jsonb;
  v_body jsonb;
  v_key text;
  v_read_keys jsonb := '{}'::jsonb;
  v_write_keys jsonb := '{}'::jsonb;
BEGIN
  IF v_claims IS NOT NULL THEN
    IF (v_claims::jsonb->>'role') IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'Family RPC requires server authorization' USING ERRCODE = '42501';
    END IF;
  ELSIF current_user IS DISTINCT FROM 'service_role'
    AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Family RPC requires server authorization' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_reads) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_writes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Read and write sets must be arrays' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_reads) > 1000 OR jsonb_array_length(p_writes) > 1000 THEN
    RAISE EXCEPTION 'Too many transaction documents' USING ERRCODE = '22023';
  END IF;

  -- Validate the ENTIRE submission before any mutation. Every write must have
  -- a captured read precondition, even a standalone set/remove or missing row.
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_reads) LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_item->'table') IS DISTINCT FROM 'string'
      OR (v_item->>'table') NOT IN
        ('summer_pet_config', 'summer_pet_events', 'summer_pet_device_requests')
      OR jsonb_typeof(v_item->'id') IS DISTINCT FROM 'string'
      OR length(v_item->>'id') NOT BETWEEN 1 AND 256
      OR NOT (v_item ? 'expected')
      OR jsonb_typeof(v_item->'expected') NOT IN ('object', 'null') THEN
      RAISE EXCEPTION 'Invalid transaction read' USING ERRCODE = '22023';
    END IF;
    v_key := jsonb_build_array(v_item->>'table', v_item->>'id')::text;
    IF v_read_keys ? v_key THEN
      RAISE EXCEPTION 'Duplicate transaction read' USING ERRCODE = '22023';
    END IF;
    v_read_keys := v_read_keys || jsonb_build_object(v_key, true);
  END LOOP;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_writes) LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_item->'table') IS DISTINCT FROM 'string'
      OR (v_item->>'table') NOT IN
        ('summer_pet_config', 'summer_pet_events', 'summer_pet_device_requests')
      OR jsonb_typeof(v_item->'id') IS DISTINCT FROM 'string'
      OR length(v_item->>'id') NOT BETWEEN 1 AND 256
      OR NOT (v_item ? 'body')
      OR jsonb_typeof(v_item->'body') NOT IN ('object', 'null')
      OR (v_item->'body') ? '_id' THEN
      RAISE EXCEPTION 'Invalid transaction write' USING ERRCODE = '22023';
    END IF;
    v_key := jsonb_build_array(v_item->>'table', v_item->>'id')::text;
    IF NOT (v_read_keys ? v_key) OR v_write_keys ? v_key THEN
      RAISE EXCEPTION 'Missing read precondition or duplicate write' USING ERRCODE = '22023';
    END IF;
    v_write_keys := v_write_keys || jsonb_build_object(v_key, true);
  END LOOP;

  -- One dedicated lock for this single-family store. All three tables and all
  -- mutation paths use it, including config revocation versus event append.
  -- The transaction lock releases automatically on commit or rollback.
  PERFORM pg_advisory_xact_lock(1937075568, 1717661037);
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_reads) LOOP
    v_body := NULL;
    EXECUTE format('SELECT body FROM public.%I WHERE id = $1', v_item->>'table')
      INTO v_body USING v_item->>'id';
    IF v_body IS DISTINCT FROM nullif(v_item->'expected', 'null'::jsonb) THEN
      RETURN jsonb_build_object('committed', false, 'conflict', true);
    END IF;
  END LOOP;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_writes) LOOP
    IF (v_item->'body') = 'null'::jsonb THEN
      EXECUTE format('DELETE FROM public.%I WHERE id = $1', v_item->>'table')
        USING v_item->>'id';
    ELSE
      EXECUTE format(
        'INSERT INTO public.%I (id, body) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body', v_item->>'table')
        USING v_item->>'id', v_item->'body';
    END IF;
  END LOOP;
  -- Any SQL failure aborts the RPC transaction; there is no partial success.
  RETURN jsonb_build_object('committed', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.summer_pet_get(text, text),
  public.summer_pet_list(text, text, integer, integer),
  public.summer_pet_commit(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.summer_pet_get(text, text),
  public.summer_pet_list(text, text, integer, integer),
  public.summer_pet_commit(jsonb, jsonb) TO service_role;

COMMIT;
