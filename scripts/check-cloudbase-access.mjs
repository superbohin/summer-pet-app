import cloudbase from "@cloudbase/js-sdk";

// Only health requests and an anonymous login; no family records are changed.
const envId = process.env.VITE_CLOUDBASE_ENV_ID;
const publishableKey = process.env.VITE_CLOUDBASE_PUBLISHABLE_KEY;
const functionName = process.env.VITE_CLOUDBASE_FUNCTION_NAME || "summer-pet-family";
const region = process.env.VITE_CLOUDBASE_REGION || "ap-shanghai";
if (!envId || !publishableKey || !/^[a-zA-Z0-9-]+$/.test(functionName)) {
  throw new Error("Valid CloudBase public settings are required");
}

function resultObject(body) {
  const value = body?.result ?? body?.data?.response_data ?? body;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

const base = `https://${envId}.api.tcloudbasegateway.com`;
const path = `/v1/functions/${functionName}`;
const variants = [
  { name: "no-session", path },
  { name: "publishable-key-only", path, key: true },
  { name: "encoded-name", path: `/v1/functions/%${functionName.charCodeAt(0).toString(16)}${functionName.slice(1)}`, key: true },
  { name: "trailing-slash", path: `${path}/`, key: true },
  { name: "encoded-slash", path: `${path}%2f`, key: true },
  { name: "double-slash", path: `/v1/functions//${functionName}`, key: true },
  {
    name: "legacy-entry", key: true,
    url: `https://${envId}.${region}.tcb-api.tencentcloudapi.com/web?env=${envId}&parse=true`,
    body: {
      action: "functions.invokeFunction", dataVersion: "2020-01-10", env: envId,
      function_name: functionName, request_data: JSON.stringify({ action: "health" }),
      parse: true, access_token: publishableKey,
    },
  },
];

let failed = false;
for (const variant of variants) {
  try {
    const response = await fetch(variant.url || `${base}${variant.path}`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": "application/json",
        ...(variant.key ? { Authorization: `Bearer ${publishableKey}` } : {}),
      },
      body: JSON.stringify(variant.body || { action: "health" }),
    });
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }
    const result = resultObject(body);
    const reachedHealth = result?.ok === true && result?.data?.service === "summer-pet-family";
    const expectedDenial = ["no-session", "publishable-key-only"].includes(variant.name);
    const forbidden = response.status === 403 || (variant.name === "no-session" && response.status === 401);
    const safeCode = typeof body?.code === "string" && /^[A-Z0-9_]{2,80}$/.test(body.code)
      ? body.code : undefined;
    const policyDenied = raw.includes("summer-pet-family requires a signed-in user session");
    const recognizedRejection = (response.status === 403 && (policyDenied || safeCode === "EXCEED_AUTHORITY"))
      || (response.status === 401 && safeCode === "MISSING_CREDENTIALS")
      || (response.status === 404 && ["FUNCTION_NOT_FOUND", "NOT_FOUND"].includes(safeCode))
      || (variant.name === "legacy-entry" && [200, 401, 403].includes(response.status) && safeCode === "INVALID_ACCESS_TOKEN");
    console.log(JSON.stringify({ check: variant.name, status: response.status, reachedHealth, policyDenied, verifiedRejection: recognizedRejection, code: safeCode }));
    if (reachedHealth || !recognizedRejection || (expectedDenial && !forbidden)) failed = true;
  } catch {
    console.error(JSON.stringify({ check: variant.name, verified: false, error: "request_failed" }));
    failed = true;
  }
}

try {
  const app = cloudbase.init({ env: envId, region, accessKey: publishableKey, timeout: 20_000 });
  const signedIn = await app.auth.signInAnonymously();
  if (signedIn.error) throw signedIn.error;
  const token = signedIn.data?.session?.access_token;
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); } catch { claims = null; }
  const subject = claims?.sub ?? signedIn.data?.session?.user?.id ?? signedIn.data?.user?.id;
  const realSession = typeof token === "string" && token !== publishableKey
    && typeof subject === "string" && subject !== "" && subject !== "anon";
  console.log(JSON.stringify({ check: "real-user-session-issued", ok: realSession }));
  if (!realSession) throw Object.assign(new Error("Missing real session"), { code: "SESSION_MISSING" });
  // Send the actual user token explicitly to isolate gateway behavior from SDK
  // transport selection; never substitute the Publishable Key for this check.
  for (const origin of [null, "https://superbohin.github.io"]) {
    const response = await fetch(`${base}${path}`, {
      method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ action: "health" }),
    });
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }
    const result = resultObject(body);
    const ok = result?.ok === true && result?.data?.service === "summer-pet-family";
    const policyDenied = raw.includes("summer-pet-family requires a signed-in user session");
    const sourceMessage = body?.message ?? body?.error?.message;
    const safeMessage = typeof sourceMessage === "string" ? sourceMessage
      .replaceAll(token, "[redacted]").replaceAll(publishableKey, "[redacted]")
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 300) : undefined;
    console.log(JSON.stringify({ check: origin ? "anonymous-pages-origin" : "signed-in-anonymous-session", status: response.status, ok, policyDenied, message: safeMessage }));
    if (!ok) failed = true;
  }
} catch (error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code : "CHECK_FAILED";
  console.error(JSON.stringify({ check: "signed-in-anonymous-session", ok: false, code }));
  failed = true;
}
// Node auth maintains refresh timers; all checks are awaited before terminating.
process.exit(failed ? 1 : 0);
