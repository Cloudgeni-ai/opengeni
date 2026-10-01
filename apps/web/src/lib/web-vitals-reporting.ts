// Web vitals for the operational beacon (client-signals.ts), reported as
// `opengeni_client_web_vital{metric,page}`. Loaded lazily after the first
// render so neither the `web-vitals` package nor this module is part of the
// initial or direct-session bundle graph.
//
// Each metric is reported at most once per document, with the final value
// web-vitals computes (LCP and CLS/INP settle when the page is hidden). Timing
// metrics are converted to seconds. `page` is the closed journey label of the
// page the document was on when reporting started, so a vital is attributed
// to the page that loaded the document, not to a later in-app navigation.
import type { ClientPage, ClientWebVitalMetric } from "@opengeni/contracts/client-error-report";
import { onCLS, onINP, onLCP, onTTFB, type Metric } from "web-vitals";

import { journeyPage } from "./analytics-journey";
import { reportClientWebVital } from "./client-signals";

/**
 * Fraction of documents that report vitals. Every document reports while
 * traffic is low; the API's per-metric admission bounds the volume.
 */
export const WEB_VITALS_SAMPLE_RATE = 1;

const METRICS: Readonly<Record<Metric["name"], ClientWebVitalMetric | null>> = {
  CLS: "cls",
  FCP: null,
  INP: "inp",
  LCP: "lcp",
  TTFB: "ttfb",
};

/** The closed page label for a pathname, never an id or a query value. */
export function webVitalPage(pathname: string): ClientPage {
  return journeyPage(pathname).page as ClientPage;
}

/** The reported value: seconds for timings, the unitless score for CLS. */
export function webVitalValue(metric: ClientWebVitalMetric, value: number): number {
  return metric === "cls" ? value : value / 1_000;
}

export function installWebVitalsReporting(
  options: {
    pathname?: string;
    random?: () => number;
    report?: typeof reportClientWebVital;
  } = {},
): void {
  if ((options.random ?? Math.random)() >= WEB_VITALS_SAMPLE_RATE) return;
  const page = webVitalPage(options.pathname ?? window.location.pathname);
  const report = options.report ?? reportClientWebVital;
  const onMetric = (metric: Metric) => {
    const name = METRICS[metric.name];
    if (name) report(name, page, webVitalValue(name, metric.value));
  };
  onLCP(onMetric);
  onINP(onMetric);
  onCLS(onMetric);
  onTTFB(onMetric);
}
