import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  avatarCatalog,
  defaultRealRewards,
  virtualShopItems,
} from "../lib/game-catalog.ts";

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
  const [manifestText, serviceWorker, builtServiceWorker] = await Promise.all([
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/client/sw.js", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.id, "/");
  assert.equal(manifest.lang, "zh-CN");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
  assert.match(serviceWorker, /CACHE_PREFIX = `summer-pet-shell-\$\{SCOPE_KEY\}-`/);
  assert.match(serviceWorker, /event\.request\.mode === "navigate"/);
  assert.match(serviceWorker, /networkFirst\(event\.request, true\)/);
  assert.match(serviceWorker, /requestUrl\.pathname\.includes\("\/assets\/"\)/);
  assert.match(serviceWorker, /caches\.match\("\/"\)/);
  assert.match(serviceWorker, /\.\.\.BUILD_ASSETS/);
  assert.match(builtServiceWorker, /const BUILD_ASSETS = \["\/assets\/[^"]+\.js"/);
  assert.match(builtServiceWorker, /"\/assets\/[^"]+\.css"/);
  assert.match(builtServiceWorker, /"\/pets\/snake-v2\.png"/);
  assert.match(builtServiceWorker, /"\/avatars\/anime-dog\.png"/);
  assert.match(builtServiceWorker, /"\/avatars\/anime-girl-star\.png"/);
  assert.match(builtServiceWorker, /"\/avatars\/eggy-yellow\.png"/);
  assert.match(builtServiceWorker, /"\/shop\/apple\.png"/);
  assert.match(builtServiceWorker, /"\/reward-categories\/gift\.png"/);
  assert.doesNotMatch(serviceWorker, /indexedDB|localStorage|deleteDatabase/);
});

test("static page CSP permits the CloudBase gateway without opening arbitrary connections", async () => {
  const html = await readFile(new URL("../pages-app/index.html", import.meta.url), "utf8");
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(policy, "Static entry must declare its CSP");
  const connections = policy.split(";").map((item) => item.trim())
    .find((item) => item.startsWith("connect-src "))?.split(/\s+/).slice(1);
  assert.ok(connections?.includes("https://*.tcloudbasegateway.com"));
  assert.ok(connections.includes("https://*.tencentcloudapi.com"));
  assert.ok(connections.includes("https://api.github.com"));
  assert.ok(!connections.includes("*") && !connections.includes("https:"));
  assert.match(policy, /script-src 'self';/);
  assert.match(policy, /object-src 'none';/);
});

test("ships and precaches every catalog image", async () => {
  const images = [...new Set([
    ...avatarCatalog.map((item) => item.image),
    ...virtualShopItems.map((item) => item.image),
    ...defaultRealRewards.map((item) => item.image),
  ])];
  const builtServiceWorker = await readFile(new URL("../dist/client/sw.js", import.meta.url), "utf8");
  await Promise.all(images.map((image) => readFile(new URL(`../public${image}`, import.meta.url))));
  for (const image of images) {
    assert.ok(builtServiceWorker.includes(JSON.stringify(image)), `${image} should be precached`);
  }
});

test("new anime heroine art ships as square RGBA PNG assets", async () => {
  const paths = [
    "/avatars/anime-girl-star.png",
    "/avatars/anime-girl-bloom.png",
    "/avatars/anime-girl-ocean.png",
    "/avatars/anime-girl-moon.png",
  ];
  for (const path of paths) {
    const png = await readFile(new URL(`../public${path}`, import.meta.url));
    assert.equal(png.readUInt32BE(16), 768, `${path} width`);
    assert.equal(png.readUInt32BE(20), 768, `${path} height`);
    assert.equal(png[25], 6, `${path} should use RGBA color type`);
  }
});

test("parent section shortcuts preserve the GitHub Pages hash route", async () => {
  const appSource = await readFile(
    new URL("../app/PetApp.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(appSource, /href=["']#parent-/);
  assert.match(appSource, /scrollToParentSection\("parent-review"\)/);
  assert.match(appSource, /scrollToParentSection\("parent-backup"\)/);
});

test("avatar art is bounded and cannot cover the name or switch button", async () => {
  const [appSource, cssSource] = await Promise.all([
    readFile(new URL("../app/PetApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(appSource, /className="avatar-art-frame"/);
  assert.match(appSource, /width="180"/);
  assert.match(appSource, /height="180"/);
  assert.match(appSource, /<button type="button" onClick=\{\(\) => selectAvatar\(avatar\)\}/);
  assert.match(cssSource, /\.avatar-art-frame[\s\S]*?overflow: hidden;/);
  assert.match(cssSource, /\.avatar-art[\s\S]*?pointer-events: none;/);
  assert.match(cssSource, /\.avatar-card button \{[\s\S]*?z-index: 2;/);
});

test("keeps update, migration and recovery safeguards explicit", async () => {
  const [appSource, dataSource, catalogSource] = await Promise.all([
    readFile(new URL("../app/PetApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/game-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/game-catalog.ts", import.meta.url), "utf8"),
  ]);
  assert.match(dataSource, /record\.completed\.includes\(taskId\)/);
  assert.match(appSource, /createTransaction\("purchase"/);
  assert.match(dataSource, /status: "pending"/);
  assert.match(appSource, /通过已勾选任务/);
  assert.match(appSource, /approveTaskSubmissionsBatch/);
  assert.match(appSource, /拒绝并退款/);
  assert.match(catalogSource, /"anime-snake"/);
  assert.match(catalogSource, /"eggy-yellow"/);
  assert.match(appSource, /visibilitychange/);
  assert.match(appSource, /setInterval\(reconcileDateAndCare/);
  assert.match(appSource, /snapshotAndReplaceGameData\(imported, "before-manual-import"\)/);
  assert.match(appSource, /createSafetySnapshot\(data, `before-app-update-/);
  assert.match(appSource, /再点一次，才会清空全部记录/);
  assert.match(dataSource, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(dataSource, /createTransaction\("task-reward"/);
  assert.match(dataSource, /createTransaction\("avatar-unlock"/);
  assert.match(dataSource, /createTransaction\("real-reward-reserve"/);
  assert.match(dataSource, /before-schema-v/);
  assert.match(dataSource, /corrupt-primary-recovery/);
  assert.match(dataSource, /care-penalty:/);
  assert.match(dataSource, /error\.reason === "future-schema"/);
  assert.doesNotMatch(dataSource, /indexedDB\.deleteDatabase|localStorage\.clear/);
});
