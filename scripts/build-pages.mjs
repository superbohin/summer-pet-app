import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { injectServiceWorkerAssets } from "./inject-service-worker-assets.mjs";

const configFile = fileURLToPath(new URL("../vite.pages.config.ts", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../pages-dist/", import.meta.url));
const manifestUrl = new URL("../pages-dist/manifest.webmanifest", import.meta.url);

function makeManifestUrlsRelative(manifest) {
  const rewriteUrl = (value) => (
    typeof value === "string" && value.startsWith("/")
      ? `.${value}`
      : value
  );

  const rewriteResourceList = (resources) => (
    Array.isArray(resources)
      ? resources.map((resource) => ({
          ...resource,
          src: rewriteUrl(resource.src),
          url: rewriteUrl(resource.url),
        }))
      : resources
  );

  return {
    ...manifest,
    id: "./",
    start_url: "./",
    scope: "./",
    icons: rewriteResourceList(manifest.icons),
    screenshots: rewriteResourceList(manifest.screenshots),
  };
}

await build({ configFile });

const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
await writeFile(
  manifestUrl,
  `${JSON.stringify(makeManifestUrlsRelative(manifest), null, 2)}\n`,
);
await injectServiceWorkerAssets(outputDirectory);
await writeFile(new URL("../pages-dist/.nojekyll", import.meta.url), "");
