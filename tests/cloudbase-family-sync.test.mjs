import assert from "node:assert/strict";
import test from "node:test";

import {
  CloudBaseFamilyClient,
  normalizeCloudBaseSettings,
} from "../lib/cloudbase-family-sync.ts";
import { familySyncProvider } from "../lib/family-sync-provider.ts";

const SETTINGS = {
  envId: "summer-pet-family-test",
  region: "ap-shanghai",
  publishableKey: "publishable-test-key",
  functionName: "summer-pet-family",
};

test("CloudBase browser settings reject missing public connection values", () => {
  assert.throws(
    () => normalizeCloudBaseSettings({ ...SETTINGS, envId: " " }),
    /EnvId/,
  );
  assert.throws(
    () => normalizeCloudBaseSettings({ ...SETTINGS, publishableKey: "" }),
    /Publishable Key/,
  );
});

test("CloudBase client trims settings and applies the default function name", () => {
  const client = new CloudBaseFamilyClient({
    ...SETTINGS,
    envId: ` ${SETTINGS.envId} `,
    functionName: "",
  });
  assert.deepEqual(client.settings, SETTINGS);
});

test("profiles created before provider migration remain GitHub profiles", () => {
  assert.equal(familySyncProvider({}), "github");
  assert.equal(familySyncProvider({ provider: "cloudbase" }), "cloudbase");
});
