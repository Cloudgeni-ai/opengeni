import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { SchedulePersonalConnectionDisclosure } from "./schedule-personal-connection-disclosure";

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
  test("renders compact schedule access without private identifiers", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <SchedulePersonalConnectionDisclosure
          ownerSubjectId="user:alice"
          viewerSubjectId="user:alice"
        />,
      ),
    );
    try {
      expect(container.textContent).toContain("Runs as you");
      expect(container.textContent).toContain("connected accounts");
      expect(container.textContent).not.toContain("user:alice");
      expect(container.textContent).not.toContain("connectionId");
      expect(container.textContent).not.toContain("ownerSubjectId");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("renders nothing for a workspace-owned schedule", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <SchedulePersonalConnectionDisclosure ownerSubjectId={null} viewerSubjectId="user:alice" />,
      ),
    );
    try {
      expect(container.textContent).toBe("");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
