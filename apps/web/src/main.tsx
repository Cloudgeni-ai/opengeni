import "./lib/crypto-random-uuid";
// Must evaluate before ./App creates the router from the current URL.
import "./lib/signup-attribution-boot";
import { AppearanceProvider } from "./lib/appearance";
import React from "react";
import { createRoot } from "react-dom/client";
import { App, appDestinationRoutePattern, appRoutePattern } from "./App";
import { apiBaseUrl, bundleDeploymentRevision } from "./api";
import {
  CLIENT_ERRORS_PATH,
  beaconSender,
  createClientErrorReporter,
  installGlobalClientErrorReporting,
  installVitePreloadErrorReporting,
  setClientErrorReporter,
} from "./lib/client-error-reporting";
import { retainIdentityLinkContinuation } from "./lib/identity-link-continuation";
import { setAnalyticsConsentDecisionSender } from "./lib/analytics-consent";
import { ANALYTICS_CONSENT_PATH } from "@opengeni/contracts/analytics-consent-report";
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
// Content-free count of analytics banner answers; see lib/analytics-consent.ts.
setAnalyticsConsentDecisionSender(beaconSender(`${apiBaseUrl}${ANALYTICS_CONSENT_PATH}`));
// Before the recovery listener, so the report is sent before a reload starts.
installVitePreloadErrorReporting({ target: window, routePattern: appDestinationRoutePattern });
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
