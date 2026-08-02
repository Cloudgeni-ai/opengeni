import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { SchedulePersonalConnectionDisclosure } from "./schedule-personal-connection-disclosure";
import { SessionPersonalConnectionDisclosure } from "./session-personal-connection-disclosure";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("personal connection disclosures", () => {
  test("renders session degradation behavior and no private identifiers", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <SessionPersonalConnectionDisclosure
          connections={[
            { serverId: "slack", providerDomain: "slack.com" },
            { serverId: "linear", providerDomain: "linear.app" },
            { serverId: "linear-alt", providerDomain: "linear.app" },
          ]}
        />,
      ),
    );
    try {
      expect(container.textContent).toContain("Personal access delegated");
      expect(container.textContent).toContain("linear.app, slack.com");
      expect(container.textContent).toContain("only that tool is skipped");
      expect(container.textContent).not.toContain("connectionId");
      expect(container.textContent).not.toContain("ownerSubjectId");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("renders compact schedule access without private identifiers", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <SchedulePersonalConnectionDisclosure
          connections={[{ serverId: "linear", providerDomain: "linear.app" }]}
        />,
      ),
    );
    try {
      expect(container.textContent).toContain("Personal access");
      expect(container.textContent).toContain("linear.app");
      expect(container.textContent).not.toContain("connectionId");
      expect(container.textContent).not.toContain("ownerSubjectId");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("renders nothing without delegated personal access", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<SchedulePersonalConnectionDisclosure connections={[]} />));
    try {
      expect(container.textContent).toBe("");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
