import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RemoveEnrollmentResponse } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { MachineRemovalBlockNotice, machineRemovalRequest } from "./machines";

const blocked: RemoveEnrollmentResponse = {
  revoked: false,
  outcome: "blocked",
  enrollmentId: "11111111-1111-4111-8111-111111111111",
  machineName: "Jrgens-MacBook-Pro-2.local",
  lastSeenAt: "2026-08-04T09:13:46.102Z",
  revokedAt: null,
  code: "active_route",
  message: "Machine is still selected by 2 sessions.",
  action: "Review the affected sessions, then explicitly move them.",
  dependentSessions: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Capacity planning",
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      title: null,
    },
  ],
};

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("connected machine removal conflict", () => {
  test("renders every dependent session inline with direct session links", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<MachineRemovalBlockNotice workspaceId="workspace-a" result={blocked} />);
    });

    expect(container.textContent).toContain("Sessions still use this machine");
    expect(container.textContent).toContain("Capacity planning");
    expect(container.textContent).toContain("33333333-3333-4333-8333-333333333333");
    expect(
      Array.from(container.querySelectorAll("a")).map((link) => link.getAttribute("href")),
    ).toEqual([
      "/workspaces/workspace-a/sessions/22222222-2222-4222-8222-222222222222",
      "/workspaces/workspace-a/sessions/33333333-3333-4333-8333-333333333333",
    ]);

    await act(async () => root.unmount());
    container.remove();
  });

  test("requires the explicit move flag only after an active-route blocker", () => {
    expect(machineRemovalRequest(null)).toEqual({});
    expect(machineRemovalRequest(blocked)).toEqual({ moveSessionsToDefaultSandbox: true });
    expect(machineRemovalRequest({ ...blocked, code: "active_lease" })).toEqual({});
  });
});
