import { describe, expect, test } from "bun:test";
import type { SandboxRecoveryProjection, SandboxRecoverySelection } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import {
  createSandboxRecoveryController,
  sameRecoverySelection,
  type SandboxRecoveryRequest,
} from "./sandbox-recovery";
import { isStructuralSandboxFailure } from "./sandbox-failure";

const selection: SandboxRecoverySelection = {
  version: 1,
  sessionId: "session",
  sandboxGroupId: "group",
  leaseId: "lease",
  routeEpoch: 1,
  authorityEpoch: 2,
  leaseEpoch: 3,
  workspaceGeneration: 12,
  archiveGeneration: 7,
  artifactId: "artifact",
  revision: "revision",
  capturedAt: "2026-09-20T08:00:00.000Z",
};
function projection(
  status: SandboxRecoveryProjection["status"] = "eligible",
): SandboxRecoveryProjection {
  return { version: 1, status, reason: null, checkpoint: selection, operationId: null };
}

describe("checkpoint recovery consent", () => {
  test("reads never mutate; explicit consent sends one exact frozen selection and UUID", async () => {
    const requests: SandboxRecoveryRequest[] = [];
    const controller = createSandboxRecoveryController(
      {
        getSandboxRecovery: async () => projection(),
        recoverSandbox: async (_workspaceId, _sessionId, request) => {
          requests.push(request);
          return {
            operationId: request.operationId,
            recovery: { ...projection("consent_accepted"), operationId: request.operationId },
          };
        },
      },
      "workspace",
      "session",
    );
    await controller.refresh();
    await controller.refresh();
    expect(requests).toHaveLength(0);
    expect(await controller.consent(selection)).toBe(true);
    expect(await controller.consent(selection)).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.selection).toEqual(selection);
    expect(requests[0]!.selection).not.toBe(selection);
    expect(Object.isFrozen(requests[0])).toBe(true);
    expect(Object.isFrozen(requests[0]!.selection)).toBe(true);
    expect(requests[0]!.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(controller.getSnapshot().projection?.status).toBe("consent_accepted");
  });

  test("every selection fence invalidates displayed consent", () => {
    expect(sameRecoverySelection(selection, { ...selection })).toBe(true);
    for (const [key, value] of Object.entries(selection)) {
      expect(
        sameRecoverySelection(selection, {
          ...selection,
          [key]: typeof value === "number" ? value + 1 : `${value}-changed`,
        }),
      ).toBe(false);
    }
    expect(sameRecoverySelection(selection, null)).toBe(false);
  });

  test("a changed checkpoint or blocked read sends nothing", async () => {
    let current = { ...projection(), checkpoint: { ...selection, archiveGeneration: 8 } };
    let writes = 0;
    const controller = createSandboxRecoveryController(
      {
        getSandboxRecovery: async () => current,
        recoverSandbox: async () => {
          writes++;
          throw new Error("must not mutate");
        },
      },
      "workspace",
      "session",
    );
    expect(await controller.consent(selection)).toBe(false);
    current = { ...projection("blocked"), checkpoint: selection };
    expect(await controller.consent(selection)).toBe(false);
    expect(writes).toBe(0);
    expect(controller.getSnapshot().request).toBeNull();
  });

  test("ambiguous mutation retains its exact key and body through changed reads without resending", async () => {
    let current = projection();
    const requests: SandboxRecoveryRequest[] = [];
    const controller = createSandboxRecoveryController(
      {
        getSandboxRecovery: async () => current,
        recoverSandbox: async (_workspaceId, _sessionId, request) => {
          requests.push(request);
          throw new Error("response lost");
        },
      },
      "workspace",
      "session",
    );
    expect(await controller.consent(selection)).toBe(false);
    expect(controller.getSnapshot().uncertain).toBe(true);
    current = { ...projection(), checkpoint: { ...selection, revision: "new" } };
    await controller.refresh();
    expect(await controller.consent(current.checkpoint!)).toBe(false);
    expect(controller.getSnapshot().request).toBe(requests[0]!);
    expect(requests).toHaveLength(1);
    current = { ...projection("restoring"), operationId: requests[0]!.operationId };
    await controller.refresh();
    expect(controller.getSnapshot().uncertain).toBe(false);
    expect(controller.getSnapshot().projection?.status).toBe("restoring");
    current = { ...current, status: "restored" };
    await controller.refresh();
    expect(controller.getSnapshot().projection?.status).toBe("restored");
    expect(requests).toHaveLength(1);
  });

  test("definitive rejection permits only new explicit consent with a new key", async () => {
    const requests: SandboxRecoveryRequest[] = [];
    const controller = createSandboxRecoveryController(
      {
        getSandboxRecovery: async () => projection(),
        recoverSandbox: async (_workspaceId, _sessionId, request) => {
          requests.push(request);
          throw new OpenGeniApiError(409, "changed");
        },
      },
      "workspace",
      "session",
    );
    await controller.consent(selection);
    expect(controller.getSnapshot().request).toBeNull();
    await controller.refresh();
    expect(requests).toHaveLength(1);
    await controller.consent(selection);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.operationId).not.toBe(requests[1]!.operationId);
  });

  test.each([401, 403, 404, 503])(
    "post-accept observation failure %s retains immutable consent without resending",
    async (status) => {
      const requests: SandboxRecoveryRequest[] = [];
      let denied = false;
      const controller = createSandboxRecoveryController(
        {
          getSandboxRecovery: async () => {
            if (denied) throw new OpenGeniApiError(404, "Session not found");
            return projection();
          },
          recoverSandbox: async (_workspaceId, _sessionId, request) => {
            requests.push(request);
            denied = true;
            // 401/403/404 reproduce older APIs' post-commit authorization race.
            throw new OpenGeniApiError(
              status,
              JSON.stringify({
                code: "upstream_unavailable",
                message: "Status unavailable",
                ...(status === 503 ? { outcomeUnknown: true, retryable: false } : {}),
              }),
              { mutation: true },
            );
          },
        },
        "workspace",
        "session",
      );
      expect(await controller.consent(selection)).toBe(false);
      expect(controller.getSnapshot().request).toBe(requests[0]!);
      expect(controller.getSnapshot().uncertain).toBe(true);
      expect(controller.getSnapshot().error).not.toContain("not accepted");
      await controller.refresh();
      expect(await controller.consent(selection)).toBe(false);
      expect(controller.getSnapshot().request).toBe(requests[0]!);
      expect(controller.getSnapshot().projection).toBeNull();
      expect(requests).toHaveLength(1);
    },
  );

  test("read errors remove stale eligibility but never discard unresolved consent", async () => {
    let failRead = false;
    const controller = createSandboxRecoveryController(
      {
        getSandboxRecovery: async () => {
          if (failRead) throw new Error("offline");
          return projection();
        },
        recoverSandbox: async () => {
          throw new Error("response lost");
        },
      },
      "workspace",
      "session",
    );
    await controller.consent(selection);
    const request = controller.getSnapshot().request;
    failRead = true;
    await controller.refresh();
    expect(controller.getSnapshot().projection).toBeNull();
    expect(controller.getSnapshot().request).toBe(request);
    expect(controller.getSnapshot().uncertain).toBe(true);
  });

  test("concurrent confirmation and polling never duplicate mutations", async () => {
    let resolve!: (value: SandboxRecoveryProjection) => void;
    let writes = 0;
    const controller = createSandboxRecoveryController(
      {
        getSandboxRecovery: () =>
          new Promise((done) => {
            resolve = done;
          }),
        recoverSandbox: async (_workspaceId, _sessionId, request) => {
          writes++;
          return { operationId: request.operationId, recovery: projection("consent_accepted") };
        },
      },
      "workspace",
      "session",
    );
    const first = controller.consent(selection);
    expect(await controller.consent(selection)).toBe(false);
    const polling = controller.refresh();
    resolve(projection());
    await Promise.all([first, polling]);
    expect(writes).toBe(1);
  });

  test("only typed structural evidence suppresses generic retry", () => {
    for (const payload of [
      { failureCategory: "archive_recovery" },
      { failureCode: "restore_degraded" },
      { code: "unrecoverable" },
    ]) {
      expect(isStructuralSandboxFailure(payload)).toBe(true);
    }
    expect(
      isStructuralSandboxFailure({ error: "archive_recovery restore_degraded unrecoverable" }),
    ).toBe(false);
    expect(isStructuralSandboxFailure({ failureCategory: "transport" })).toBe(false);
  });
  test("a 403 read marks recovery not applicable without a failed-check notice", async () => {
    let status = 403;
    const controller = createSandboxRecoveryController(
      {
        getSandboxRecovery: async () => {
          throw new OpenGeniApiError(status, JSON.stringify({ error: { message: "denied" } }));
        },
        recoverSandbox: async () => {
          throw new Error("unexpected mutation");
        },
      },
      "workspace",
      "session",
    );
    expect(await controller.refresh()).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({
      projection: null,
      notApplicable: true,
      error: null,
    });
    status = 503;
    await controller.refresh();
    expect(controller.getSnapshot().notApplicable).toBe(false);
    expect(controller.getSnapshot().error).toContain("Could not check checkpoint recovery");
  });
});
