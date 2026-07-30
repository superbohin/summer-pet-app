import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the finished Chinese pet app", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>我的暑假小伙伴<\/title>/i);
  assert.match(html, /正在叫醒你的小伙伴/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("includes an installable offline-first manifest and service worker", async () => {
  const [manifestText, serviceWorker] = await Promise.all([
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.id, "/");
  assert.equal(manifest.lang, "zh-CN");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
  assert.match(serviceWorker, /CACHE_PREFIX = "summer-pet-shell-"/);
  assert.match(serviceWorker, /event\.request\.mode === "navigate"/);
  assert.match(serviceWorker, /networkFirst\(event\.request, true\)/);
  assert.match(serviceWorker, /requestUrl\.pathname\.includes\("\/assets\/"\)/);
  assert.match(serviceWorker, /caches\.match\("\/"\)/);
  assert.doesNotMatch(serviceWorker, /indexedDB|localStorage|deleteDatabase/);
});

test("keeps update, migration and recovery safeguards explicit", async () => {
  const [appSource, dataSource] = await Promise.all([
    readFile(new URL("../app/PetApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/game-data.ts", import.meta.url), "utf8"),
  ]);
  assert.match(appSource, /record\.completed\.includes\(task\.id\)/);
  assert.match(appSource, /createTransaction\("task-reward"/);
  assert.match(appSource, /createTransaction\("purchase"/);
  assert.match(appSource, /snapshotAndReplaceGameData\(imported, "before-manual-import"\)/);
  assert.match(appSource, /createSafetySnapshot\(data, `before-app-update-/);
  assert.match(appSource, /再点一次，才会清空全部记录/);
  assert.match(dataSource, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(dataSource, /before-schema-v/);
  assert.match(dataSource, /corrupt-primary-recovery/);
  assert.doesNotMatch(dataSource, /indexedDB\.deleteDatabase|localStorage\.clear/);
});
