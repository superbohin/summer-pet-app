import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import FamilyApp from "../app/FamilyApp";
import "../app/globals.css";
import "../app/family-access.css";
import { appBaseUrl } from "../lib/app-base";

type Surface = "child" | "parent";

function surfaceFromHash(
  hash = typeof window === "undefined" ? "" : window.location.hash,
): Surface {
  return hash.replace(/^#\/?/, "").split(/[/?]/, 1)[0] === "parent"
    ? "parent"
    : "child";
}

function PagesApp() {
  const [surface, setSurface] = useState<Surface>(() => surfaceFromHash());

  useEffect(() => {
    const updateSurface = () => setSurface(surfaceFromHash());
    window.addEventListener("hashchange", updateSurface);
    return () => window.removeEventListener("hashchange", updateSurface);
  }, []);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register(appBaseUrl("/sw.js")).catch(() => undefined);
    }
  }, []);

  return <FamilyApp initialSurface={surface} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PagesApp />
  </StrictMode>,
);
