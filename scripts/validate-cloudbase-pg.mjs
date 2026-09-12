import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Exercise the actual PostgreSQL migration and transaction functions, then
// ROLLBACK everything. This never installs a schema or leaves sample records.
const envId = process.env.VITE_CLOUDBASE_ENV_ID;
if (!envId) throw new Error("VITE_CLOUDBASE_ENV_ID is required");
const cli = process.env.CLOUDBASE_CLI || fileURLToPath(new URL(
  "../work/cloudbase-tools/node_modules/.bin/tcb", import.meta.url,
));
const migration = await readFile(new URL("../cloudbase/sql/001-family-sync.sql", import.meta.url), "utf8");
if (!/^BEGIN;/m.test(migration) || !/COMMIT;\s*$/.test(migration)) {
  throw new Error("Expected one transaction ending in COMMIT");
}
const id = `validation_${crypto.randomUUID()}`;
const checks = `
DO $validation$
DECLARE
  result jsonb;
BEGIN
  result := public.summer_pet_commit(
    '[{"table":"summer_pet_config","id":"${id}","expected":null}]',
    '[{"table":"summer_pet_config","id":"${id}","body":{"version":1}}]'
  );
  IF result->>'committed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Initial commit failed'; END IF;
  result := public.summer_pet_get('summer_pet_config', '${id}');
  IF result->'document' IS DISTINCT FROM '{"version":1}'::jsonb THEN RAISE EXCEPTION 'Readback failed'; END IF;

  result := public.summer_pet_commit(
    '[{"table":"summer_pet_config","id":"${id}","expected":null},{"table":"summer_pet_events","id":"${id}","expected":null}]',
    '[{"table":"summer_pet_events","id":"${id}","body":{"test":true}}]'
  );
  IF result->>'conflict' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Stale precondition accepted'; END IF;
  result := public.summer_pet_get('summer_pet_events', '${id}');
  IF result->'document' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Conflict partially wrote data'; END IF;

  result := public.summer_pet_list('summer_pet_events', 'timestamp_id', 0, 2);
  IF jsonb_typeof(result->'documents') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Pagination failed'; END IF;

  -- Gateway JWT roles must be checked even when the SQL connection itself is privileged.
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.summer_pet_get('summer_pet_config', '${id}');
    RAISE EXCEPTION 'Anonymous JWT bypassed the RPC gate';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('request.jwt.claims', '{}', true);
  BEGIN
    PERFORM public.summer_pet_commit('[]', '[]');
    RAISE EXCEPTION 'Missing JWT role bypassed the RPC gate';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM public.summer_pet_get('summer_pet_config', '${id}');
  PERFORM set_config('request.jwt.claims', '', true);

  IF has_table_privilege('anon', 'public.summer_pet_config', 'SELECT')
     OR has_table_privilege('authenticated', 'public.summer_pet_events', 'INSERT')
     OR has_table_privilege('anon', 'public.summer_pet_device_requests', 'UPDATE') THEN
    RAISE EXCEPTION 'Client still has direct table privileges';
  END IF;
END;
$validation$;
ROLLBACK;
SELECT true AS validation_passed_and_rolled_back;
`;
const sql = migration.replace(/COMMIT;\s*$/, checks);
try {
  const output = execFileSync(cli, [
    "db", "execute", "-e", envId, "--sql", sql, "--json",
  ], { encoding: "utf8", maxBuffer: 1_000_000, timeout: 60_000 });
  const response = JSON.parse(output.slice(output.indexOf("{")));
  if (response.error) throw new Error(response.error.message || "PostgreSQL validation failed");
  const rows = response.data?.Rows;
  if (!rows?.some((row) => (typeof row === "string" ? JSON.parse(row) : row)
    .some((value) => value === true || value === "true"))) {
    throw new Error("PostgreSQL did not confirm the validation rollback");
  }
  console.log("PostgreSQL migration, CAS, atomic conflict handling and RPC role checks passed; all changes rolled back.");
} catch (error) {
  const raw = error.stdout?.toString() || error.message;
  console.error(raw.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]"));
  process.exitCode = 1;
}
