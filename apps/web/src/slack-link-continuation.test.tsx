import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createSlackLinkPrepareController,
  invalidSlackLinkQueryWorkspaceIdFromUrl,
  pendingSlackLinkFromUrl,
  preserveSlackLinkForManagedAuth,
} from "./context";
import { SlackLinkAccessRequiredDescription } from "./routes/workspace";

const workspaceId = "00000000-0000-4000-8000-000000000141";

describe("Slack link continuation", () => {
  test("only a raw explicit continuation crosses managed sign-in", () => {
    expect(preserveSlackLinkForManagedAuth("signin", "raw")).toBe(true);
    for (const phase of ["none", "in_flight", "prepared", "failed"] as const) {
      expect(preserveSlackLinkForManagedAuth("signin", phase)).toBe(false);
    }
    expect(preserveSlackLinkForManagedAuth("signup", "raw")).toBe(false);
  });

  test("accepts only the log-safe fragment form on capabilities", () => {
    expect(
      pendingSlackLinkFromUrl(
        `https://app.example.test/workspaces/${workspaceId}/capabilities#slack_link=signed.fragment`,
      ),
    ).toEqual({ workspaceId, token: "signed.fragment" });
    expect(
      pendingSlackLinkFromUrl(
        `https://app.example.test/workspaces/${workspaceId}/capabilities?slack_link=signed.query`,
      ),
    ).toBeNull();
    expect(
      pendingSlackLinkFromUrl(
        `https://app.example.test/workspaces/${workspaceId}/sessions#slack_link=signed.fragment`,
      ),
    ).toBeNull();
  });

  test("retains only a token-free route marker for rejected legacy query bearers", () => {
    expect(
      invalidSlackLinkQueryWorkspaceIdFromUrl(
        "https://app.test/workspaces/workspace-1/capabilities?slack_link=legacy-secret",
      ),
    ).toBe("workspace-1");
    expect(
      invalidSlackLinkQueryWorkspaceIdFromUrl(
        "https://app.test/workspaces/workspace-1/sessions?slack_link=legacy-secret",
      ),
    ).toBeNull();
  });

  test("renders the required sentence with only the proven workspace name emphasized", () => {
    const markup = renderToStaticMarkup(
      <p>
        <SlackLinkAccessRequiredDescription workspaceName="Platform" />
      </p>,
    );
    expect(markup).toBe(
      "<p>You need access to <strong>Platform</strong> to connect your Slack account.</p>",
    );
    expect(
      renderToStaticMarkup(
        <p>
          <SlackLinkAccessRequiredDescription workspaceName="this workspace" />
        </p>,
      ),
    ).toContain(
      "You need access to <strong>this workspace</strong> to connect your Slack account.",
    );
  });

  test("survives a pre-prepare remount, creates one flight, and zeros the raw bearer", async () => {
    const pending = {
      workspaceId: "00000000-0000-4000-8000-000000000141",
      token: "one-shot-signed-link",
    };
    const controller = createSlackLinkPrepareController<{ id: string }>(pending);
    expect(controller.workspaceId()).toBe(pending.workspaceId);
    expect(controller.phase()).toBe("raw");

    let resolvePrepare!: (request: { id: string }) => void;
    const exchangeCalls: string[] = [];
    const first = controller.prepare(pending.workspaceId, (token) => {
      exchangeCalls.push(token);
      return new Promise((resolve) => {
        resolvePrepare = resolve;
      });
    });
    expect(controller.phase()).toBe("in_flight");
    const remounted = controller.prepare(pending.workspaceId, async () => {
      throw new Error("a remount must join the existing token-free flight");
    });
    expect(remounted).toBe(first);
    expect(exchangeCalls).toEqual([pending.token]);

    resolvePrepare({ id: "prepared-request" });
    await expect(first).resolves.toEqual({ id: "prepared-request" });
    expect(controller.phase()).toBe("prepared");
    await expect(
      controller.prepare(pending.workspaceId, async () => {
        throw new Error("a successful prepare must not be followed by a second failing exchange");
      }),
    ).resolves.toEqual({ id: "prepared-request" });
    expect(exchangeCalls).toEqual([pending.token]);
  });

  test("a failed one-flight prepare remains deduped across remounts until terminal clear", async () => {
    const controller = createSlackLinkPrepareController<{ id: string }>({
      workspaceId,
      token: "failing-signed-link",
    });
    let rejectPrepare!: (error: Error) => void;
    let exchanges = 0;
    const first = controller.prepare(workspaceId, () => {
      exchanges += 1;
      return new Promise((_, reject) => {
        rejectPrepare = reject;
      });
    });
    const remounted = controller.prepare(workspaceId, async () => {
      exchanges += 1;
      return { id: "must-not-run" };
    });
    expect(remounted).toBe(first);
    rejectPrepare(new Error("prepare failed"));
    await expect(first).rejects.toThrow("prepare failed");
    expect(controller.phase()).toBe("failed");
    await expect(
      controller.prepare(workspaceId, async () => {
        exchanges += 1;
        return { id: "must-not-retry" };
      }),
    ).rejects.toThrow("prepare failed");
    expect(exchanges).toBe(1);

    controller.clear();
    expect(controller.workspaceId()).toBeNull();
    expect(controller.phase()).toBe("none");
  });

  test("an unrelated principal transition clears and fences an in-flight exchange", async () => {
    const controller = createSlackLinkPrepareController<{ id: string }>({
      workspaceId,
      token: "old-principal-signed-link",
    });
    let resolvePrepare!: (request: { id: string }) => void;
    const oldExchange = controller.prepare(
      workspaceId,
      () =>
        new Promise((resolve) => {
          resolvePrepare = resolve;
        }),
    );
    expect(controller.phase()).toBe("in_flight");

    controller.clear();
    resolvePrepare({ id: "old-principal-request" });
    await expect(oldExchange).resolves.toEqual({ id: "old-principal-request" });
    expect(controller.workspaceId()).toBeNull();
    expect(controller.phase()).toBe("none");
    await expect(
      controller.prepare(workspaceId, async () => ({ id: "must-not-run" })),
    ).resolves.toBeNull();
  });
});
