import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalStringify, validateEventEnvelope } from "../lib/github-family-sync.ts";

const MAX_EVENT_INPUT_BYTES = 256 * 1024;
const repositoryRoot = process.env.GITHUB_WORKSPACE
  ? resolve(process.env.GITHUB_WORKSPACE)
  : resolve(process.cwd());
const configPath = resolve(repositoryRoot, "config/household.json");
const eventsDirectory = resolve(repositoryRoot, "events");

function decodeEventInput(value) {
  if (!value || typeof value !== "string") {
    throw new Error("EVENT_BASE64 is required");
  }
  const encodedBytes = Buffer.byteLength(value, "utf8");
  if (encodedBytes > MAX_EVENT_INPUT_BYTES) {
    throw new Error("EVENT_BASE64 exceeds the 256 KiB safety limit");
  }
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || decoded.toString("base64").replace(/=+$/, "") !== value.replace(/\s/g, "").replace(/=+$/, "")) {
    throw new Error("EVENT_BASE64 is not valid canonical base64");
  }
  return JSON.parse(decoded.toString("utf8"));
}

async function main() {
  const event = decodeEventInput(process.env.EVENT_BASE64);
  const config = JSON.parse(await readFile(configPath, "utf8"));

  await validateEventEnvelope(event, config, { mode: "append" });

  // validateEventEnvelope restricts this value before it reaches the filesystem.
  const eventPath = resolve(eventsDirectory, `${event.id}.json`);
  if (!eventPath.startsWith(`${eventsDirectory}/`)) {
    throw new Error("Unsafe event ID");
  }

  await mkdir(eventsDirectory, { recursive: true });
  let handle;
  try {
    handle = await open(eventPath, "wx", 0o600);
    await handle.writeFile(`${canonicalStringify(event)}\n`, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(`Event ${event.id} already exists; append-only history cannot be overwritten`);
    }
    if (handle) await unlink(eventPath).catch(() => {});
    throw error;
  } finally {
    await handle?.close();
  }

  process.stdout.write(`Validated and appended family event ${event.id}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown family sync validation failure";
  process.stderr.write(`Family sync rejected: ${message}\n`);
  process.exitCode = 1;
});
