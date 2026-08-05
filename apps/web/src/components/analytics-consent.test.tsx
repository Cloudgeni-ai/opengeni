import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { openAnalyticsPreferences } from "@/lib/analytics-consent";

import { AnalyticsManager } from "./analytics-consent";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("analytics consent accessibility", () => {
  test("subjects modern theme colors to the manual contrast audit", async () => {
    window.localStorage.clear();
    window.localStorage.setItem("opengeni.analyticsConsent", "denied");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <AnalyticsManager
            config={{
              consentRequired: true,
              providers: { posthog: { projectKey: "phc_test", host: "https://example.com" } },
            }}
            hasSearchParameters={false}
            isPublicAuthRoute={false}
            pathname="/workspaces/workspace-1/sessions"
            analyticsAccountId={null}
            analyticsUserId={null}
          />,
        );
      });
      await act(async () => openAnalyticsPreferences());

      const copy = container.querySelector<HTMLElement>(
        'section[aria-label="Analytics preferences"] > p.mt-1',
      );
      expect(copy).not.toBeNull();
      expect(copy!.hasAttribute("data-contrast-audited")).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      window.localStorage.clear();
    }
  });
});
