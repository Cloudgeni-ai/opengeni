import type { AnalyticsEventName, AnalyticsProperties } from "./analytics";

type Observer = {
  capture: (name: AnalyticsEventName, properties?: AnalyticsProperties) => boolean;
  request: (pathname: string, method: string) => (status: number | null) => void;
  connection: (
    provider: "codex" | "supergrok" | "ai-gateway" | "openrouter",
    workspaceId: string,
  ) => (outcome: "connected" | "expired" | "denied" | "outcome_unknown") => void;
};
let observer: Observer | null = null;
const ignore = () => {};
/** Keep the optional provider implementation outside the direct-session bundle. */
export function installAnalyticsObserver(value: Observer): void {
  observer = value;
}
export const captureAnalyticsEvent: Observer["capture"] = (name, properties) =>
  observer?.capture(name, properties) ?? false;
export const beginAnalyticsRequest: Observer["request"] = (pathname, method) =>
  observer?.request(pathname, method) ?? ignore;
export const trackModelConnection: Observer["connection"] = (provider, workspaceId) =>
  observer?.connection(provider, workspaceId) ?? ignore;
