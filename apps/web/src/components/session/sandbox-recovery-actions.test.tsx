import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SandboxRecoveryProjection } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type { SandboxRecoveryClient, SandboxRecoveryRequest } from "@/lib/sandbox-recovery";

// Radix detects browser support at import time, before rendering its real portal.
try {
  GlobalRegistrator.register();
} catch {
  /* Already installed by another test. */
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { SandboxRecoveryActions } = await import("./sandbox-recovery-actions");
const { FailedSessionActions } = await import("./failed-session-actions");
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});

const eligible: SandboxRecoveryProjection = {
  version: 1,
  status: "eligible",
  reason: null,
  operationId: null,
  checkpoint: {
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
  },
};
async function render(
  client: SandboxRecoveryClient,
  structuralFailure = true,
  canControl = true,
  retryOptions: { onRetry?: () => Promise<boolean>; retryBlocker?: "paused" | null } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <SandboxRecoveryActions
        client={client}
        sessionId="session"
        workspaceId="workspace"
        canControl={canControl}
        structuralFailure={structuralFailure}
        retryActions={
          <FailedSessionActions
            onRetry={retryOptions.onRetry ?? (async () => true)}
            retryBlocker={retryOptions.retryBlocker ?? null}
          />
        }
      >
        <button>Try again</button>
        <button>Choose another model</button>
      </SandboxRecoveryActions>,
    ),
  );
  return container;
}
function button(text: string): HTMLButtonElement {
  const result = [...document.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!result) throw new Error(`Missing button: ${text}. UI: ${document.body.textContent}`);
  return result;
}
async function click(text: string) {
  await act(async () => button(text).click());
}

test("explicit confirmation names exact timestamp and generation gap, and cancel sends nothing", async () => {
  let writes = 0;
  const container = await render({
    getSandboxRecovery: async () => eligible,
    recoverSandbox: async () => {
      writes++;
      throw new Error("unexpected mutation");
    },
  });
  expect(container.textContent).not.toContain("Try again");
  expect(container.textContent).not.toContain("Choose another model");
  expect(container.querySelectorAll("button")).toHaveLength(1);
  await click("Review checkpoint recovery");
  expect(document.body.textContent).toContain(eligible.checkpoint!.capturedAt);
  expect(document.body.textContent).toContain("Generation gap: 5 (7 → 12)");
  expect(document.body.textContent).toContain("not a count of lost files");
  expect(document.body.textContent).toContain(
    "Files changed after this checkpoint will be unavailable",
  );
  expect(document.body.textContent).toContain("Conversation history is preserved");
  expect(document.body.textContent).toContain("External effects are not undone");
  expect(document.body.textContent).toContain("No commands will be retried or replayed");
  await click("Cancel");
  expect(writes).toBe(0);
});

test("an automatically recoverable failed session offers only Retry with a filesystem warning", async () => {
  let retries = 0;
  let consentWrites = 0;
  const container = await render(
    {
      getSandboxRecovery: async () => ({ ...eligible, automaticAvailable: true }),
      recoverSandbox: async () => {
        consentWrites++;
        throw new Error("automatic fallback must not submit human consent");
      },
    },
    true,
    true,
    {
      onRetry: async () => {
        retries++;
        return true;
      },
    },
  );
  expect(container.textContent).toContain("Newer sandbox files may be unavailable");
  expect(container.textContent).not.toContain("Review checkpoint recovery");
  expect(container.querySelectorAll("button")).toHaveLength(1);
  await click("Retry");
  expect(retries).toBe(1);
  expect(consentWrites).toBe(0);
});

test("acceptance is not restoration and double clicks never replay mutation", async () => {
  const requests: SandboxRecoveryRequest[] = [];
  const container = await render({
    getSandboxRecovery: async () => eligible,
    recoverSandbox: async (_workspaceId, _sessionId, request) => {
      requests.push(request);
      return {
        operationId: request.operationId,
        recovery: { ...eligible, status: "consent_accepted", operationId: request.operationId },
      };
    },
  });
  await click("Review checkpoint recovery");
  await act(async () => {
    const accept = button("Accept and restore checkpoint");
    accept.click();
    accept.click();
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.selection).toEqual(eligible.checkpoint!);
  expect(container.textContent).toContain("consent accepted");
  expect(container.textContent).toContain("Restoration has not completed");
  expect(container.textContent).not.toContain("Checkpoint restored");
});

test("changed current selection invalidates open consent without silently updating it", async () => {
  let reads = 0;
  let writes = 0;
  await render({
    getSandboxRecovery: async () =>
      ++reads === 1
        ? eligible
        : { ...eligible, checkpoint: { ...eligible.checkpoint!, revision: "changed" } },
    recoverSandbox: async () => {
      writes++;
      throw new Error("unexpected mutation");
    },
  });
  await click("Review checkpoint recovery");
  await click("Accept and restore checkpoint");
  expect(writes).toBe(0);
  expect(document.body.textContent).toContain("availability changed");
  expect(button("Accept and restore checkpoint").disabled).toBe(true);
  await click("Cancel");
});

test("ambiguous outcomes allow GET checks only, not a new consent or mutation", async () => {
  let writes = 0;
  let reads = 0;
  const container = await render({
    getSandboxRecovery: async () => {
      reads++;
      return eligible;
    },
    recoverSandbox: async () => {
      writes++;
      throw new Error("response lost");
    },
  });
  await click("Review checkpoint recovery");
  await click("Accept and restore checkpoint");
  expect(container.textContent).toContain("outcome unconfirmed");
  expect(container.textContent).not.toContain("Review checkpoint recovery");
  await click("Check recovery status");
  expect(reads).toBe(3);
  expect(writes).toBe(1);
  expect(container.textContent).not.toContain("Checkpoint restored");
});

test("unavailable reads and unsupported structural failures never fall back to retry or models", async () => {
  let fail = true;
  const container = await render({
    getSandboxRecovery: async () => {
      if (fail) throw new Error("offline");
      return { ...eligible, status: "unsupported", checkpoint: null };
    },
    recoverSandbox: async () => {
      throw new Error("unexpected mutation");
    },
  });
  expect(container.textContent).toContain("Could not check checkpoint recovery");
  expect(container.textContent).not.toContain("Try again");
  fail = false;
  await click("Check recovery status");
  expect(container.textContent).toContain("unavailable");
  expect(container.textContent).not.toContain("Choose another model");
});

test.each([false, true])(
  "a 403 read (structural %p) is not applicable, not a failed check",
  async (structural) => {
    let reads = 0;
    const container = await render(
      {
        getSandboxRecovery: async () => {
          reads++;
          throw new OpenGeniApiError(
            403,
            JSON.stringify({ error: { code: "forbidden", message: "Managed human required." } }),
          );
        },
        recoverSandbox: async () => {
          throw new Error("unexpected mutation");
        },
      },
      structural,
    );
    expect(reads).toBe(1);
    expect(container.textContent).not.toContain("Could not check checkpoint recovery");
    expect(container.textContent).not.toContain("Checking checkpoint recovery");
    expect(container.textContent).not.toContain("Check recovery status");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // The lane defers to its caller's ordinary remedies; the banner already
    // withholds generic Retry from structural failures.
    expect(container.textContent).toContain("Try again");
  },
);

test("a 403 read after an unconfirmed consent keeps the notice and status checks", async () => {
  let denied = false;
  let reads = 0;
  let writes = 0;
  const container = await render(
    {
      getSandboxRecovery: async () => {
        reads++;
        if (denied)
          throw new OpenGeniApiError(403, JSON.stringify({ error: { message: "denied" } }));
        return eligible;
      },
      recoverSandbox: async () => {
        writes++;
        throw new Error("response lost");
      },
    },
    false,
  );
  await click("Review checkpoint recovery");
  await click("Accept and restore checkpoint");
  expect(container.textContent).toContain("outcome unconfirmed");
  denied = true;
  await click("Check recovery status");
  expect(container.textContent).toContain("outcome unconfirmed");
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    "Could not check checkpoint recovery",
  );
  expect(container.textContent).not.toContain("Try again");
  const before = reads;
  await click("Check recovery status");
  expect(reads).toBe(before + 1);
  expect(writes).toBe(1);
});

test("nonstructural unsupported recovery preserves ordinary failure controls", async () => {
  const container = await render(
    {
      getSandboxRecovery: async () => ({ ...eligible, status: "unsupported", checkpoint: null }),
      recoverSandbox: async () => {
        throw new Error("unexpected mutation");
      },
    },
    false,
  );
  expect(container.textContent).toContain("Try again");
  expect(container.textContent).toContain("Choose another model");
});

test("permission denial never exposes consent even with eligible projection", async () => {
  const container = await render(
    {
      getSandboxRecovery: async () => eligible,
      recoverSandbox: async () => {
        throw new Error("unexpected mutation");
      },
    },
    true,
    false,
  );
  expect(container.textContent).toContain("do not have permission");
  expect(container.textContent).not.toContain("Review checkpoint recovery");
});

test("healthy no-gap Modal projection preserves unrelated failure remedies", async () => {
  const container = await render(
    {
      getSandboxRecovery: async () => ({
        ...eligible,
        status: "blocked",
        reason: "historical_checkpoint_not_required",
        checkpoint: null,
      }),
      recoverSandbox: async () => {
        throw new Error("unexpected mutation");
      },
    },
    false,
  );
  expect(container.textContent).toContain("Try again");
  expect(container.textContent).toContain("Choose another model");
});

test.each([
  { reason: "historical_checkpoint_not_required", structural: true, operationId: null },
  {
    reason: "historical_checkpoint_not_required",
    structural: false,
    operationId: "prior-operation",
  },
  { reason: "restore_failed", structural: false, operationId: "prior-operation" },
  { reason: "consent_stale", structural: false, operationId: "prior-operation" },
  {
    reason: "restored_checkpoint_no_longer_ready",
    structural: false,
    operationId: "prior-operation",
  },
  { reason: "checkpoint_artifact_invalid", structural: false, operationId: null },
])(
  "blocked $reason does not offer unrelated remedies when recovery is unresolved",
  async ({ reason, structural, operationId }) => {
    const container = await render(
      {
        getSandboxRecovery: async () => ({
          ...eligible,
          status: "blocked",
          reason,
          operationId,
          checkpoint: null,
        }),
        recoverSandbox: async () => {
          throw new Error("unexpected mutation");
        },
      },
      structural,
    );
    expect(container.textContent).not.toContain("Try again");
    expect(container.textContent).not.toContain("Choose another model");
    expect(container.textContent).not.toContain("Review checkpoint recovery");
  },
);

test.each(["restoring", "restored"] as const)(
  "renders authoritative %s separately from acceptance",
  async (status) => {
    const container = await render({
      getSandboxRecovery: async () => ({ ...eligible, status }),
      recoverSandbox: async () => {
        throw new Error("unexpected mutation");
      },
    });
    expect(container.textContent).toContain(
      status === "restoring" ? "Restoration has not completed" : "Checkpoint restored",
    );
    expect(container.textContent?.includes("Retry")).toBe(status === "restored");
    expect(container.textContent).not.toContain("Choose another model");
    expect(container.textContent).not.toContain("Review checkpoint recovery");
  },
);

test.each(["restored", "connected_machine"] as const)(
  "%s offers explicit Retry despite historical failure/receipt, never automatic replay or model switching",
  async (route) => {
    let retries = 0;
    let writes = 0;
    const container = await render(
      {
        getSandboxRecovery: async () =>
          route === "restored"
            ? { ...eligible, status: "restored", operationId: "durable-operation" }
            : {
                ...eligible,
                status: "unsupported",
                reason: "connected_machine_selected",
                checkpoint: null,
              },
        recoverSandbox: async () => {
          writes++;
          throw new Error("No recovery mutation expected");
        },
      },
      true,
      true,
      {
        onRetry: async () => {
          retries++;
          return true;
        },
      },
    );
    expect(retries).toBe(0);
    expect(writes).toBe(0);
    expect(container.textContent).not.toContain("Choose another model");
    expect(container.textContent).not.toContain("Review checkpoint recovery");
    await click("Retry");
    expect(retries).toBe(1);
    expect(container.textContent).toContain("Retry requested.");
    expect(container.querySelector("button")).toBeNull();
    expect(writes).toBe(0);
  },
);

test("verified restoration retains Pause and permission fences", async () => {
  let retries = 0;
  await render(
    {
      getSandboxRecovery: async () => ({
        ...eligible,
        status: "restored",
        operationId: "durable-operation",
      }),
      recoverSandbox: async () => {
        throw new Error("No mutation expected");
      },
    },
    true,
    true,
    {
      retryBlocker: "paused",
      onRetry: async () => {
        retries++;
        return true;
      },
    },
  );
  expect(document.querySelector("button")).toBeNull();
  expect(retries).toBe(0);
});

test("verified restoration does not offer Retry without control permission", async () => {
  const container = await render(
    {
      getSandboxRecovery: async () => ({
        ...eligible,
        status: "restored",
        operationId: "durable-operation",
      }),
      recoverSandbox: async () => {
        throw new Error("No mutation expected");
      },
    },
    true,
    false,
  );
  expect(container.textContent).not.toContain("Retry");
});
