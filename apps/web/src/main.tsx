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
import { createClientSignalReporter, setClientSignalReporter } from "./lib/client-signals";
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
// An undeliverable report is retried once when the browser is next online.
const sendBeacon = beaconSender(`${apiBaseUrl}${CLIENT_ERRORS_PATH}`, globalThis.fetch, {
  retryTarget: window,
});
setClientErrorReporter(
  createClientErrorReporter({ send: sendBeacon, revision: bundleDeploymentRevision || "dev" }),
);
// Failed key requests, live-stream health and web vitals share that beacon;
// see lib/client-signals.ts. Automated browsers (`navigator.webdriver`, such
// as CI acceptance runs) do not report them, so they never skew the series.
const reportClientSignals = !navigator.webdriver;
if (reportClientSignals) {
  setClientSignalReporter(
    createClientSignalReporter({
      send: sendBeacon,
      revision: bundleDeploymentRevision || "dev",
      routePattern: appRoutePattern,
    }),
  );
}
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

// Web vitals load after the page settles, outside the initial bundle graph.
if (reportClientSignals) {
  window.addEventListener(
    "load",
    () =>
      setTimeout(() => {
        void import("./lib/web-vitals-reporting")
          .then(({ installWebVitalsReporting }) => installWebVitalsReporting())
          .catch(() => undefined);
      }, 0),
    { once: true },
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppearanceProvider>
      <App />
    </AppearanceProvider>
  </React.StrictMode>,
);
