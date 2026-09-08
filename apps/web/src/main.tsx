import "./lib/crypto-random-uuid";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { retainIdentityLinkContinuation } from "./lib/identity-link-continuation";
import {
  availableSessionStorage,
  currentViteBuildId,
  installVitePreloadRecovery,
} from "./lib/vite-preload-recovery";
import "streamdown/styles.css";
import "./styles.css";

retainIdentityLinkContinuation(window);
const preloadRecoveryStorage = availableSessionStorage(window);
if (preloadRecoveryStorage) {
  installVitePreloadRecovery({
    target: window,
    storage: preloadRecoveryStorage,
    buildId: currentViteBuildId(document),
    reload: () => window.location.reload(),
  });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
