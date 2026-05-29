import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import App from "./App";
import { I18nProvider } from "./i18n";

// When the served build is rebuilt while a client (e.g. a phone over the share
// tunnel) has the page open, lazily-loaded chunks — like Mermaid's diagram
// renderers — point at hashes that no longer exist and fail with "Importing a
// module script failed". Vite fires `vite:preloadError`; reload to fetch the
// current index.html (served no-cache). The recent-reload check breaks a loop
// if a chunk is genuinely gone, while still allowing recovery from a later
// rebuild in the same session.
window.addEventListener("vite:preloadError", () => {
  const last = Number(sessionStorage.getItem("chunk-reloaded-at") || 0);
  if (Date.now() - last < 10_000) return;
  sessionStorage.setItem("chunk-reloaded-at", String(Date.now()));
  window.location.reload();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
