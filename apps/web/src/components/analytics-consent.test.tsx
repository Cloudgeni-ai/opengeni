import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  openAnalyticsPreferences,
  setAnalyticsConsentDecisionSender,
} from "@/lib/analytics-consent";

import { AnalyticsManager, analyticsClickEvent } from "./analytics-consent";

// Granting consent starts the provider; keep it in-process.
mock.module("posthog-js", () => ({
  default: {
    capture: () => undefined,
    group: () => undefined,
    identify: () => undefined,
    init: () => undefined,
    opt_in_capturing: () => undefined,
    opt_out_capturing: () => undefined,
    register_once: () => undefined,
    reset: () => undefined,
    resetGroups: () => undefined,
  },
}));

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
            analyticsAccountResolved={false}
            analyticsUserId={null}
          />,
        );
      });
      await act(async () => openAnalyticsPreferences());

      const section = container.querySelector<HTMLElement>(
        'section[aria-label="Analytics preferences"]',
      );
      expect(section).not.toBeNull();
      const copy = section!.querySelectorAll<HTMLElement>("p.text-fg-muted, details p");
      expect(copy.length).toBeGreaterThan(0);
      for (const paragraph of copy) {
        expect(paragraph.hasAttribute("data-contrast-audited")).toBe(true);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      window.localStorage.clear();
    }
  });

  test("docks in normal flow instead of floating over sign-in or onboarding controls", async () => {
    window.localStorage.clear();
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
            pathname="/"
            analyticsAccountId={null}
            analyticsAccountResolved={false}
            analyticsUserId={null}
          />,
        );
      });

      const section = container.querySelector<HTMLElement>(
        'section[aria-label="Analytics preferences"]',
      );
      expect(section).not.toBeNull();
      expect(section!.className).not.toContain("fixed");
      expect(section!.className).toContain("order-last");
      expect(section!.className).toContain("shrink-0");
      expect(container.textContent).toContain("Allow analytics");
      expect(container.textContent).toContain("Decline");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      window.localStorage.clear();
    }
  });

  test("counts each changed banner answer on the server with only the decision", async () => {
    window.localStorage.clear();
    const sent: string[] = [];
    setAnalyticsConsentDecisionSender((body) => sent.push(body));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const choose = async (label: string) => {
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      expect(button).toBeDefined();
      await act(async () => button!.click());
    };

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
            pathname="/"
            analyticsAccountId={null}
            analyticsAccountResolved={false}
            analyticsUserId={null}
          />,
        );
      });
      await choose("Decline");
      expect(sent).toEqual([JSON.stringify({ decision: "denied" })]);
      // Re-confirming the same answer from Account preferences is not counted.
      await act(async () => openAnalyticsPreferences());
      await choose("Decline");
      expect(sent).toHaveLength(1);
      await act(async () => openAnalyticsPreferences());
      await choose("Allow analytics");
      expect(sent).toEqual([
        JSON.stringify({ decision: "denied" }),
        JSON.stringify({ decision: "granted" }),
      ]);
    } finally {
      setAnalyticsConsentDecisionSender(null);
      await act(async () => root.unmount());
      container.remove();
      window.localStorage.clear();
    }
  });
});

describe("analytics click projection", () => {
  const origin = "https://app.opengeni.test";
  const workspace = "11111111-1111-4111-8111-111111111111";

  test("attaches a closed action label to links and buttons, never their text", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <a id="new" href="${origin}/workspaces/${workspace}/sessions" data-analytics-action="new_session"><span>New session for a private project</span></a>
      <a id="plain" href="${origin}/workspaces/${workspace}/settings?section=models">Settings</a>
      <button id="buy" data-analytics-action="buy_credits"><svg></svg>Buy $25 in credits</button>
      <button id="free-text" data-analytics-action="Buy credits now">Buy</button>
      <div id="tab" role="tab">Overview</div>
      <p id="text">Not a control</p>`;
    document.body.append(container);
    try {
      const target = (id: string) => container.querySelector(`#${id}`)!;
      expect(analyticsClickEvent(target("new").firstElementChild, origin)).toEqual({
        name: "navigation_clicked",
        properties: { destination_page: "sessions", action: "new_session" },
      });
      expect(analyticsClickEvent(target("plain"), origin)).toEqual({
        name: "navigation_clicked",
        properties: { destination_page: "settings", destination_section: "models" },
      });
      expect(analyticsClickEvent(target("buy").querySelector("svg"), origin)).toEqual({
        name: "product_clicked",
        properties: { action: "buy_credits", control_kind: "button" },
      });
      expect(analyticsClickEvent(target("free-text"), origin)).toEqual({
        name: "product_clicked",
        properties: { control_kind: "button" },
      });
      expect(analyticsClickEvent(target("tab"), origin)).toEqual({
        name: "product_clicked",
        properties: { control_kind: "tab" },
      });
      expect(analyticsClickEvent(target("text"), origin)).toBeNull();
      expect(analyticsClickEvent(null, origin)).toBeNull();
    } finally {
      container.remove();
    }
  });
});
