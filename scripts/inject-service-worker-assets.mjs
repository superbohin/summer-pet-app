import { readdir, readFile, writeFile } from "node:fs/promises";

const assetsDirectory = new URL("../dist/client/assets/", import.meta.url);
const serviceWorkerUrl = new URL("../dist/client/sw.js", import.meta.url);
const entries = await readdir(assetsDirectory, { withFileTypes: true });
const buildAssets = entries
  .filter((entry) => entry.isFile() && /\.(?:css|js)$/.test(entry.name))
  .map((entry) => `/assets/${entry.name}`)
  .sort();

if (buildAssets.length === 0) {
  throw new Error("No built JavaScript or CSS assets were found for offline precaching");
}

const serviceWorker = await readFile(serviceWorkerUrl, "utf8");
const marker = /^const BUILD_ASSETS = .*;$/m;
if (!marker.test(serviceWorker)) {
  throw new Error("Unable to find the Service Worker build-assets marker");
}

await writeFile(
  serviceWorkerUrl,
  serviceWorker.replace(marker, `const BUILD_ASSETS = ${JSON.stringify(buildAssets)};`),
);
