import "./lib/crypto-random-uuid";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { currentViteBuildId, installVitePreloadRecovery } from "./lib/vite-preload-recovery";
import "streamdown/styles.css";
import "./styles.css";

installVitePreloadRecovery({
  target: window,
  storage: window.sessionStorage,
  buildId: currentViteBuildId(document),
  reload: () => window.location.reload(),
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
