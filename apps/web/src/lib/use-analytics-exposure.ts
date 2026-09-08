import { useEffect } from "react";
import { captureAnalyticsEvent } from "./analytics-observer";
import { ANALYTICS_COLLECTION_ENABLED_EVENT } from "./analytics-consent";

/** Recheck a visible gate after first-visit consent without treating it as a click. */
export function useCreditExposure(visible: boolean, workspaceId: string): void {
  useEffect(() => {
    const record = () => {
      if (visible) captureAnalyticsEvent("credits_required_viewed", { workspace_id: workspaceId });
    };
    record();
    window.addEventListener(ANALYTICS_COLLECTION_ENABLED_EVENT, record);
    return () => window.removeEventListener(ANALYTICS_COLLECTION_ENABLED_EVENT, record);
  }, [visible, workspaceId]);
}
