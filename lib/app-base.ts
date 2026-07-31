/**
 * Resolve a public app resource against the current deployment root.
 *
 * Vinext/Sites serves at `/`, while a GitHub Pages project normally lives at
 * an unknown `/<repository>/` path. `document.baseURI` handles both without
 * baking a repository name into the bundle.
 */
export function appBaseUrl(path = ""): string {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path)) {
    return path;
  }

  const relativePath = path.replace(/^\/+/, "");

  if (typeof document === "undefined") {
    return relativePath ? `/${relativePath}` : "/";
  }

  const viteBase = (
    import.meta as ImportMeta & { env?: { BASE_URL?: string } }
  ).env?.BASE_URL;
  const deploymentRoot = new URL(viteBase ?? "./", document.baseURI);
  return new URL(relativePath, deploymentRoot).toString();
}
