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
  assert.equal(manifest.lang, "zh-CN");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
  assert.match(serviceWorker, /caches\.open/);
  assert.match(serviceWorker, /event\.request\.mode === "navigate"/);
  assert.match(serviceWorker, /caches\.match\("\/"\)/);
});

test("keeps core game rules explicit and idempotent", async () => {
  const source = await readFile(new URL("../app/PetApp.tsx", import.meta.url), "utf8");
  assert.match(source, /record\.completed\.includes\(task\.id\)/);
  assert.match(source, /isFull && !record\.fullBonus/);
  assert.match(source, /fullBonus: record\.fullBonus \|\| grantBonus/);
  assert.match(source, /Math\.max\(0, current\.pet\.coins - reward\.coins/);
  assert.match(source, /if \(current\.pet\.coins < pendingBuy\.price\) return current/);
  assert.match(source, /isGameData\(parsed\)/);
  assert.match(source, /再点一次，才会清空全部记录/);
});
