import { afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useMemo, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FailedSessionActions } from "./failed-session-actions";
import { FailureRecoveryBoundary } from "./failure-recovery-boundary";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { createFailedSessionRetry, type FailedSessionRetryInput } from "@/lib/failed-session-retry";

mock.module("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#fixture">{children}</a>,
}));
const { FailedSessionBanner } = await import("./failed-session-banner");
beforeAll(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    /* shared DOM */
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});
async function render(children: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(children));
  return container;
}
const failure = {
  reason: "Connection interrupted.",
  failedAt: null,
  consecutiveRecoveryCount: null,
};
const actions = { onRetry: async () => true, retryBlocker: null };

test("compact row offers one ghost Retry without duplicate controls or guidance", async () => {
  const container = await render(<FailedSessionBanner failure={failure} actions={actions} />);
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(container.querySelector("button")!.textContent).toBe("Retry");
  expect(container.querySelector("button")!.dataset.variant).toBe("ghost");
  expect(container.querySelector("svg")).not.toBeNull();
  expect(container.querySelector("details")).toBeNull();
  expect(container.textContent).not.toMatch(/Choose another model|composer|preserved|Try again/);
  expect(container.querySelector('[data-testid="failed-session-banner"]')!.className).not.toMatch(
    /bg-|border|rounded/,
  );
});

test("credential failures hide Retry until another model is chosen and keep raw detail folded", async () => {
  const raw =
    "401 Incorrect API key provided: sk-proj-****abcd. You can find your API key at https://platform.openai.com/account/api-keys.";
  const credentialFailure = {
    ...failure,
    reason:
      "The model provider rejected this deployment's engine credentials. Sending messages won't help until the deployment's engine configuration is fixed.",
    recordedDetail: raw,
  };
  const container = await render(
    <FailedSessionBanner failure={credentialFailure} actions={actions} canChooseModel />,
  );
  const banner = container.querySelector<HTMLElement>('[data-testid="failed-session-banner"]')!;
  expect(banner.querySelector("button")).toBeNull();
  const details = banner.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")!.textContent).toBe("Details");
  expect(details.querySelector("p")!.textContent).toBe(raw);
  expect(banner.textContent?.replace(details.textContent ?? "", "")).toBe(
    "The model provider rejected the credentials for this model. Choose another model below.",
  );
  await act(async () =>
    root!.render(
      <FailedSessionBanner failure={credentialFailure} actions={actions} modelChanged />,
    ),
  );
  expect(container.querySelector("button")!.textContent).toBe("Retry");
});

test("billing and daily-limit failures keep Retry on the same model", async () => {
  const banner = (raw: string) => (
    <FailedSessionBanner
      failure={{ ...failure, reason: raw, recordedDetail: raw }}
      actions={actions}
      canChooseModel
    />
  );
  const container = await render(banner("402 Payment Required"));
  for (const raw of [
    "402 This request requires more credits. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account",
    "429 Rate limit exceeded: free-models-per-day. Add 10 credits to unlock more.",
  ]) {
    await act(async () => root!.render(banner(raw)));
    const row = container.querySelector<HTMLElement>('[data-testid="failed-session-banner"]')!;
    expect(row.textContent).toContain("Choose another model below.");
    expect(row.querySelectorAll("button")).toHaveLength(1);
    expect(row.querySelector("button")!.textContent).toBe("Retry");
  }
});

test("double clicks and accepted submissions never duplicate recovery", async () => {
  let settle!: (value: boolean) => void;
  let sends = 0;
  const container = await render(
    <FailedSessionActions
      {...actions}
      onRetry={() => {
        sends++;
        return new Promise((resolve) => {
          settle = resolve;
        });
      }}
    />,
  );
  const button = container.querySelector("button")!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(sends).toBe(1);
  expect(button.textContent).toBe("Retrying…");
  await act(async () => settle(true));
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector('[role="status"]')!.textContent).toBe("Retry requested.");
});

test("typed structural sandbox failure never exposes retry or model-switch remedies", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <FailedSessionBanner
        failure={{
          reason: "Checkpoint is older than workspace",
          failedAt: null,
          consecutiveRecoveryCount: null,
          structuralSandboxFailure: true,
        }}
        actions={{
          onRetry: async () => true,
          retryBlocker: null,
        }}
      />,
    ),
  );
  expect(container.textContent).not.toContain("Retry");
  expect(container.textContent).not.toContain("Choose another model");
  expect(container.textContent).toBe("Checkpoint is older than workspace");
  expect(container.querySelectorAll("button")).toHaveLength(0);
});
test("all draft, delivery, work, permission and deliberate pause guards hide Retry", async () => {
  let sends = 0;
  const container = await render(null);
  for (const retryBlocker of [
    "draft",
    "unsent",
    "delivery",
    "queued",
    "loading",
    "permission",
    "paused",
  ] as const) {
    await act(async () =>
      root!.render(
        <FailedSessionActions
          retryBlocker={retryBlocker}
          onRetry={async () => {
            sends++;
            return true;
          }}
        />,
      ),
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("");
  }
  for (const composerBlocker of [
    "upload",
    "repository",
    "policy",
    "variable_sets",
    "personal_decision",
    "personal_loading",
  ] as const) {
    await act(async () =>
      root!.render(<FailedSessionActions {...actions} composerBlocker={composerBlocker} />),
    );
    expect(container.querySelector("button")).toBeNull();
  }
  expect(sends).toBe(0);
});

test("sandbox projection gates compact Retry and structural failures override billing", async () => {
  const sandboxRecovery = {
    workspaceId: "workspace-a",
    sessionId: "session-a",
    canControl: true,
    client: {
      getSandboxRecovery: async () => ({
        version: 1 as const,
        status: "unsupported" as const,
        reason: null,
        operationId: null,
        checkpoint: null,
      }),
      recoverSandbox: async () => {
        throw new Error("Rendering must not submit consent");
      },
    },
  };
  const container = await render(
    <FailedSessionBanner failure={failure} actions={actions} sandboxRecovery={sandboxRecovery} />,
  );
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(container.querySelector("button")!.textContent).toBe("Retry");
  await act(async () =>
    root!.render(
      <FailedSessionBanner
        failure={{
          ...failure,
          reason: "Checkpoint is older than workspace",
          structuralSandboxFailure: true,
        }}
        actions={actions}
        sandboxRecovery={sandboxRecovery}
        creditExhausted
        workspaceId="workspace-a"
        canBuyCredits
        canConnectModel
        canChooseModel
      />,
    ),
  );
  expect(container.querySelectorAll('[data-testid="failed-session-banner"]')).toHaveLength(1);
  expect(container.querySelectorAll("a")).toHaveLength(0);
  expect(container.textContent).toContain("Checkpoint is older than workspace");
  expect(container.textContent).not.toMatch(/Retry|Choose another|credits/);
  expect(container.querySelector("button")!.textContent).toBe("Check recovery status");
});

test("a viewer who cannot use checkpoint recovery keeps Retry and sees no failed check", async () => {
  const sandboxRecovery = {
    workspaceId: "workspace-a",
    sessionId: "session-a",
    canControl: true,
    client: {
      getSandboxRecovery: async () => {
        throw new OpenGeniApiError(
          403,
          JSON.stringify({ error: { code: "forbidden", message: "Managed human required." } }),
        );
      },
      recoverSandbox: async () => {
        throw new Error("Rendering must not submit consent");
      },
    },
  };
  const container = await render(
    <FailedSessionBanner failure={failure} actions={actions} sandboxRecovery={sandboxRecovery} />,
  );
  expect(container.textContent).not.toContain("checkpoint recovery");
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(container.querySelector("button")!.textContent).toBe("Retry");
  await act(async () =>
    root!.render(
      <FailedSessionBanner
        failure={{ ...failure, structuralSandboxFailure: true }}
        actions={actions}
        sandboxRecovery={sandboxRecovery}
      />,
    ),
  );
  expect(container.textContent).toBe("Connection interrupted.");
  expect(container.querySelector("button")).toBeNull();
});

test.each(["restored", "connected_machine", "automatic"] as const)(
  "%s projection exposes only explicit compact Retry through the structural banner",
  async (route) => {
    let retries = 0;
    const sandboxRecovery = {
      workspaceId: "workspace-a",
      sessionId: "session-a",
      canControl: true,
      client: {
        getSandboxRecovery: async () => ({
          version: 1 as const,
          status:
            route === "restored"
              ? ("restored" as const)
              : route === "automatic"
                ? ("eligible" as const)
                : ("unsupported" as const),
          reason: route === "connected_machine" ? "connected_machine_selected" : null,
          operationId: route === "restored" ? "durable-operation" : null,
          automaticAvailable: route === "automatic",
          checkpoint:
            route === "automatic"
              ? {
                  version: 1 as const,
                  sessionId: "session-a",
                  sandboxGroupId: "group-a",
                  leaseId: "lease-a",
                  routeEpoch: 0,
                  authorityEpoch: 1,
                  leaseEpoch: 2,
                  workspaceGeneration: 12,
                  archiveGeneration: 7,
                  artifactId: "artifact-a",
                  revision: "revision-a",
                  capturedAt: "2026-09-20T08:00:00.000Z",
                }
              : null,
        }),
        recoverSandbox: async () => {
          throw new Error("Current route must not submit consent");
        },
      },
    };
    const failureProps = { ...failure, structuralSandboxFailure: true };
    const retryProps = {
      ...actions,
      onRetry: async () => {
        retries++;
        return true;
      },
    };
    const container = await render(
      <FailedSessionBanner
        failure={failureProps}
        actions={retryProps}
        sandboxRecovery={sandboxRecovery}
      />,
    );
    expect(retries).toBe(0);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector("button")!.textContent).toBe("Retry");
    if (route === "automatic")
      expect(container.textContent).toContain("Newer sandbox files may be unavailable");
    expect(container.querySelector("button")!.dataset.variant).toBe("ghost");
    expect(container.textContent).not.toContain("Choose another model");
    await act(async () =>
      root!.render(
        <FailedSessionBanner
          failure={failureProps}
          actions={{ ...retryProps, retryBlocker: "paused" }}
          sandboxRecovery={sandboxRecovery}
        />,
      ),
    );
    expect(container.querySelector("button")).toBeNull();
    await act(async () =>
      root!.render(
        <FailedSessionBanner
          failure={{ ...failureProps, safetyRefusal: true }}
          actions={retryProps}
          sandboxRecovery={sandboxRecovery}
        />,
      ),
    );
    expect(container.querySelector("button")).toBeNull();
    await act(async () =>
      root!.render(
        <FailedSessionBanner
          failure={{ ...failureProps, reason: "The model is unavailable" }}
          actions={retryProps}
          sandboxRecovery={sandboxRecovery}
        />,
      ),
    );
    expect(container.querySelector("button")).toBeNull();
    await act(async () =>
      root!.render(
        <FailedSessionBanner
          failure={failureProps}
          actions={retryProps}
          sandboxRecovery={sandboxRecovery}
        />,
      ),
    );
    expect(retries).toBe(0);
    await act(async () => container.querySelector("button")!.click());
    expect(retries).toBe(1);
    expect(container.querySelector("button")).toBeNull();
  },
);

test("local non-submission remains retryable", async () => {
  const container = await render(<FailedSessionActions {...actions} onRetry={async () => false} />);
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("Could not retry");
  expect(container.querySelector("button")!.disabled).toBe(false);
});

test("history hydration retains guards; a distinct failure resets them", async () => {
  let settle!: (value: boolean) => void;
  const props = {
    ...actions,
    onRetry: () =>
      new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
  };
  const container = await render(<FailedSessionActions {...props} />);
  await act(async () => container.querySelector("button")!.click());
  await act(async () => root!.render(<FailedSessionActions {...props} failureId="first" />));
  expect(container.querySelector("button")!.textContent).toBe("Retrying…");
  await act(async () => root!.render(<FailedSessionActions {...props} failureId="second" />));
  await act(async () => settle(true));
  expect(container.querySelector("button")!.textContent).toBe("Retry");
});

test("unknown outcome checks the identical frozen operation instead of a new retry", async () => {
  const inputs: FailedSessionRetryInput[] = [];
  function Recovery() {
    const [retryInput, setRetryInput] = useState<FailedSessionRetryInput | null>(null);
    const retry = useMemo(
      () =>
        createFailedSessionRetry(async (input) => {
          inputs.push(input);
          if (inputs.length === 1) throw new Error("Response lost");
        }, setRetryInput),
      [],
    );
    return (
      <FailedSessionActions
        {...actions}
        retryInput={retryInput}
        onRetry={() =>
          retry("failure-a", {
            model: "selected-model",
            reasoningEffort: "medium",
            latencyMode: "standard",
          })
        }
      />
    );
  }
  const container = await render(<Recovery />);
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(container.querySelector("button")!.textContent).toBe("Check retry");
  expect(container.textContent).not.toContain("Choose");
  await act(async () => container.querySelector("button")!.click());
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toBe(inputs[0]);
  expect(container.querySelector("button")).toBeNull();
});

test("definitive unsafe retry rejection removes the action", async () => {
  const container = await render(
    <FailedSessionActions
      {...actions}
      onRetry={async () => {
        throw new OpenGeniApiError(409, "Unsupported failure", {
          code: "RETRY_UNSUPPORTED_FAILURE",
        });
      }}
    />,
  );
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    "cannot be retried safely",
  );
});

for (const code of ["RETRY_PAUSED", "RETRY_EXECUTION_UNRESOLVED"] as const) {
  test(`${code} allows explicit retry after the same failure's transient blocker clears`, async () => {
    let sends = 0;
    const onRetry = async () => {
      if (++sends === 1) throw new OpenGeniApiError(409, "Blocked", { code });
      return true;
    };
    const container = await render(
      <FailedSessionActions failureId="same-failure" retryBlocker={null} onRetry={onRetry} />,
    );
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(
      code === "RETRY_PAUSED" ? "This session is paused." : "Earlier work is still settling.",
    );
    await act(async () =>
      root!.render(
        <FailedSessionActions
          failureId="same-failure"
          retryBlocker={code === "RETRY_PAUSED" ? "paused" : "queued"}
          onRetry={onRetry}
        />,
      ),
    );
    expect(container.querySelector("button")).toBeNull();
    await act(async () =>
      root!.render(
        <FailedSessionActions failureId="same-failure" retryBlocker={null} onRetry={onRetry} />,
      ),
    );
    expect(sends).toBe(1);
    await act(async () => container.querySelector("button")!.click());
    expect(sends).toBe(2);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
}

test("unsupported model directs to existing picker; a changed model permits recovery", async () => {
  const unavailable = {
    ...failure,
    reason: "The model `example` is not supported with this account.",
  };
  const container = await render(
    <FailedSessionBanner failure={unavailable} actions={actions} canChooseModel />,
  );
  expect(container.textContent).toBe("This model isn’t available. Choose another below.");
  expect(container.querySelector("button")).toBeNull();
  await act(async () =>
    root!.render(
      <FailedSessionBanner failure={unavailable} actions={actions} canChooseModel={false} />,
    ),
  );
  expect(container.textContent).toBe("This model isn’t available.");
  expect(container.querySelector("button")).toBeNull();
  await act(async () =>
    root!.render(<FailedSessionBanner failure={unavailable} actions={actions} modelChanged />),
  );
  expect(container.querySelector("button")!.textContent).toBe("Retry");
});

test("safety refusal preserves draft and has no recovery action", async () => {
  const container = await render(
    <>
      <FailedSessionBanner failure={{ ...failure, safetyRefusal: true }} actions={actions} />
      <textarea defaultValue="My draft" />
    </>,
  );
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector("textarea")!.value).toBe("My draft");
});

test("billing offers at most one authorized action and never Retry", async () => {
  const container = await render(null);
  for (const [canBuyCredits, canConnectModel, expected] of [
    [true, true, "Buy credits"],
    [false, true, "Connect a model"],
    [false, false, null],
  ] as const) {
    await act(async () =>
      root!.render(
        <FailedSessionBanner
          failure={failure}
          creditExhausted
          workspaceId="workspace-a"
          canBuyCredits={canBuyCredits}
          canConnectModel={canConnectModel}
          actions={actions}
        />,
      ),
    );
    expect(container.querySelectorAll("a")).toHaveLength(expected ? 1 : 0);
    expect(container.querySelector("a")?.textContent ?? null).toBe(expected);
    expect(container.querySelector("button")).toBeNull();
  }
});

test("unknown provider evidence never invents expiry, reset or connection classification", async () => {
  const container = await render(
    <FailedSessionBanner
      failure={{ ...failure, reason: "Connection failed." }}
      actions={actions}
    />,
  );
  expect(container.textContent).toBe("Connection failed.Retry");
  expect(container.textContent).not.toMatch(/Codex|expired|reset|reconnect/i);
});

test("unavailable recovery chunk preserves error and composer draft", async () => {
  function Unavailable(): never {
    throw new Error("fixture unavailable");
  }
  const container = await render(
    <>
      <FailureRecoveryBoundary fallback={<p role="alert">Connection failed.</p>}>
        <Unavailable />
      </FailureRecoveryBoundary>
      <textarea defaultValue="My draft" />
    </>,
  );
  expect(container.querySelector('[role="alert"]')!.textContent).toBe("Connection failed.");
  expect(container.querySelector("textarea")!.value).toBe("My draft");
});
