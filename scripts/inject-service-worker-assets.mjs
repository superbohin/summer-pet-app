import { readdir, readFile, writeFile } from "node:fs/promises";

const clientDirectory = new URL("../dist/client/", import.meta.url);
const serviceWorkerUrl = new URL("../dist/client/sw.js", import.meta.url);

async function collectFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await collectFiles(new URL(`${entry.name}/`, directory), relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

const buildAssets = (await collectFiles(clientDirectory))
  .filter((path) =>
    (/^assets\/.*\.(?:css|js|woff2)$/.test(path)) ||
    (/^(?:pets|avatars|shop|reward-categories)\/.*\.(?:png|webp)$/.test(path))
  )
  .map((path) => `/${path}`)
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
