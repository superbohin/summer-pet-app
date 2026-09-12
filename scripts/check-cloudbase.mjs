import { CloudBaseFamilyClient } from "../lib/cloudbase-family-sync.ts";

const settings = {
  envId: process.env.VITE_CLOUDBASE_ENV_ID ?? "",
  region: process.env.VITE_CLOUDBASE_REGION ?? "ap-shanghai",
  publishableKey: process.env.VITE_CLOUDBASE_PUBLISHABLE_KEY ?? "",
  functionName: process.env.VITE_CLOUDBASE_FUNCTION_NAME ?? "summer-pet-family",
};

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (settings.publishableKey
    ? message.replaceAll(settings.publishableKey, "[redacted]")
    : message
  ).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
}

try {
  const client = new CloudBaseFamilyClient(settings);
  const health = await client.health();
  console.log(JSON.stringify({ check: "function", service: health.service, ok: true }));
  try {
    const result = await client.readConfig();
    console.log(JSON.stringify({
      check: "database",
      ok: true,
      initialized: true,
      configVersion: result.config.version,
    }));
  } catch (error) {
    const message = safeMessage(error);
    if (/CONFIG_NOT_FOUND|Family config has not been initialized/.test(message)) {
      console.log(JSON.stringify({ check: "database", ok: true, initialized: false }));
    } else {
      throw error;
    }
  }
} catch (error) {
  console.error(JSON.stringify({ check: "cloudbase", ok: false, error: safeMessage(error) }));
  process.exitCode = 1;
}
