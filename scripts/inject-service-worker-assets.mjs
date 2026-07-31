import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

function precacheOrder(left, right) {
  const priority = (path) => {
    if (/^assets\/.*\.js$/i.test(path)) return 0;
    if (/^assets\/.*\.css$/i.test(path)) return 1;
    if (path.startsWith("assets/")) return 2;
    return 3;
  };
  const leftPriority = priority(left);
  const rightPriority = priority(right);
  return leftPriority - rightPriority || left.localeCompare(right);
}

export async function injectServiceWorkerAssets(outputDirectory) {
  const directoryUrl = pathToFileURL(`${resolve(outputDirectory)}/`);
  const serviceWorkerUrl = new URL("sw.js", directoryUrl);
  const buildAssets = (await collectFiles(directoryUrl))
    .filter((path) =>
      path !== "sw.js" &&
      /\.(?:avif|css|gif|ico|jpe?g|js|mjs|otf|png|svg|ttf|webp|woff2?)$/i.test(path)
    )
    .sort(precacheOrder)
    .map((path) => `/${path}`);

  if (!buildAssets.some((path) => /^\/assets\/.*\.(?:css|js)$/i.test(path))) {
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await injectServiceWorkerAssets(
    process.argv[2] ?? fileURLToPath(new URL("../dist/client/", import.meta.url)),
  );
}
