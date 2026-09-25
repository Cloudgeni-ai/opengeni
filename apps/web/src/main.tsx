import "./lib/crypto-random-uuid";
import { AppearanceProvider } from "./lib/appearance";
import React from "react";
import { createRoot } from "react-dom/client";
import { App, appRoutePattern } from "./App";
import { apiBaseUrl, bundleDeploymentRevision } from "./api";
import {
  CLIENT_ERRORS_PATH,
  beaconSender,
  createClientErrorReporter,
  installGlobalClientErrorReporting,
  setClientErrorReporter,
} from "./lib/client-error-reporting";
import { retainIdentityLinkContinuation } from "./lib/identity-link-continuation";
import {
  availableSessionStorage,
  currentViteBuildId,
  installVitePreloadRecovery,
} from "./lib/vite-preload-recovery";
import "./styles.css";

retainIdentityLinkContinuation(window);
// Content-free operational error counter; see lib/client-error-reporting.ts.
setClientErrorReporter(
  createClientErrorReporter({
    send: beaconSender(`${apiBaseUrl}${CLIENT_ERRORS_PATH}`),
    revision: bundleDeploymentRevision || "dev",
  }),
);
installGlobalClientErrorReporting({ target: window, routePattern: appRoutePattern });
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
    <AppearanceProvider>
      <App />
    </AppearanceProvider>
  </React.StrictMode>,
);
