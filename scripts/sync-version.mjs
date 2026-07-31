import { readFile, writeFile } from "node:fs/promises";

const packageInfo = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const versionUrl = new URL("../public/version.json", import.meta.url);
const serviceWorkerUrl = new URL("../public/sw.js", import.meta.url);
const gameDataUrl = new URL("../lib/game-data.ts", import.meta.url);

const gameData = await readFile(gameDataUrl, "utf8");
const schemaMatch = gameData.match(/^export const CURRENT_SCHEMA_VERSION = (\d+);/m);
if (!schemaMatch) throw new Error("Unable to read the current data schema version");

const versionInfo = JSON.parse(await readFile(versionUrl, "utf8"));
versionInfo.version = packageInfo.version;
versionInfo.schemaVersion = Number(schemaMatch[1]);
await writeFile(versionUrl, `${JSON.stringify(versionInfo, null, 2)}\n`);

const serviceWorker = await readFile(serviceWorkerUrl, "utf8");
const updatedServiceWorker = serviceWorker.replace(
  /^const APP_VERSION = "[^"]+";/m,
  `const APP_VERSION = "${packageInfo.version}";`,
);
if (updatedServiceWorker === serviceWorker && !serviceWorker.includes(`const APP_VERSION = "${packageInfo.version}";`)) {
  throw new Error("Unable to synchronize the Service Worker version");
}
await writeFile(serviceWorkerUrl, updatedServiceWorker);

const updatedGameData = gameData.replace(
  /^export const APP_VERSION = "[^"]+";/m,
  `export const APP_VERSION = "${packageInfo.version}";`,
);
if (updatedGameData === gameData && !gameData.includes(`export const APP_VERSION = "${packageInfo.version}";`)) {
  throw new Error("Unable to synchronize the application data version");
}
await writeFile(gameDataUrl, updatedGameData);
