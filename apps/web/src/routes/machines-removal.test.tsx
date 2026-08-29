import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RemoveEnrollmentResponse } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  MachineRemovalBlockNotice,
  copyToClipboard,
  moveDependentSessionsToDefault,
} from "./machines";

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

  test("moves every dependency through the canonical default-sandbox endpoint", async () => {
    const calls: Array<{ workspaceId: string; sessionId: string; target: string }> = [];
    await moveDependentSessionsToDefault(
      {
        swapActiveSandbox: async (workspaceId, sessionId, request) => {
          calls.push({ workspaceId, sessionId, target: request.target });
          return { swapped: true, activeSandboxId: null, activeEpoch: calls.length };
        },
      },
      "workspace-a",
      blocked.dependentSessions,
    );
    expect(calls).toEqual([
      {
        workspaceId: "workspace-a",
        sessionId: "22222222-2222-4222-8222-222222222222",
        target: "default",
      },
      {
        workspaceId: "workspace-a",
        sessionId: "33333333-3333-4333-8333-333333333333",
        target: "default",
      },
    ]);
  });

  test("stops before removal when a default sandbox is not verified ready", async () => {
    await expect(
      moveDependentSessionsToDefault(
        {
          swapActiveSandbox: async () => ({
            swapped: false,
            activeSandboxId: "44444444-4444-4444-8444-444444444444",
            activeEpoch: 7,
            code: "recovery_in_progress",
            reason: "The managed sandbox is still restoring.",
          }),
        },
        "workspace-a",
        blocked.dependentSessions,
      ),
    ).rejects.toThrow("The managed sandbox is still restoring.");
  });

  test("renders a machine-home blocker without offering a false managed-home action", async () => {
    const machineHome = {
      ...blocked,
      code: "machine_home" as const,
      message: "Machine is the durable home sandbox for Capacity planning.",
      action: "Keep the machine enrolled until a managed-home migration exists.",
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<MachineRemovalBlockNotice workspaceId="workspace-a" result={machineHome} />);
    });

    expect(container.textContent).toContain("Not safe yet");
    expect(container.textContent).toContain("durable home sandbox");
    expect(container.textContent).toContain("managed-home migration");

    await act(async () => root.unmount());
    container.remove();
  });
});

describe("connected machine command copy", () => {
  test("falls back when the Clipboard API is unavailable on private HTTP", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const copied: string[] = [];
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: (command: string) => {
        if (command === "copy") {
          copied.push(document.querySelector("textarea")?.value ?? "");
          return true;
        }
        return false;
      },
    });

    await expect(copyToClipboard("curl https://example.test/install", "Copied")).resolves.toBe(
      true,
    );
    expect(copied).toEqual(["curl https://example.test/install"]);
    expect(document.querySelector("textarea")).toBeNull();
  });
});
