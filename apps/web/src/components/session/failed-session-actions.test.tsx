import { getComposerSendBlocker } from "@/lib/composer-send-blocking";
import { FailureRecoveryBoundary } from "./failure-recovery-boundary";
import { afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FailedSessionActions } from "./failed-session-actions";
import { OpenGeniApiError } from "@opengeni/sdk/browser";

mock.module("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#models">{children}</a>,
}));

const { FailedSessionBanner } = await import("./failed-session-banner");

beforeAll(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    // Another web test in this process already installed Happy DOM.
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});
async function render(props: Parameters<typeof FailedSessionActions>[0]) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<FailedSessionActions {...props} />));
  return container;
}
test("one Try again click sequence requests recovery without a follow-up message", async () => {
  let settle!: (accepted: boolean) => void;
  const receipt = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  let sends = 0;
  let modelOpens = 0;
  const container = await render({
    onRetry: async () => {
      sends++;
      return receipt;
    },
    retryBlocker: null,
    onChooseModel: () => {
      modelOpens++;
    },
    modelDisabled: false,
  });
  const [continueButton, modelButton] = [...container.querySelectorAll("button")];
  await act(async () => {
    continueButton!.click();
    continueButton!.click();
  });
  expect(sends).toBe(1);
  expect(continueButton!.textContent).toBe("Trying again…");
  await act(async () => settle(true));
  await act(async () => continueButton!.click());
  expect(sends).toBe(1);
  expect(continueButton!.textContent).toBe("Retry requested");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("original request");
  expect(container.textContent).not.toContain("follow-up");
  await act(async () => modelButton!.click());
  expect(modelOpens).toBe(1);
});
test("failed local submission remains retryable and blocked drafts explain the reason", async () => {
  let sends = 0;
  const props = {
    onRetry: async () => {
      sends++;
      return false;
    },
    retryBlocker: null as "draft" | null,
    onChooseModel: () => {},
    modelDisabled: false,
  };
  const container = await render(props);
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not retry");
  expect(container.querySelector("button")!.disabled).toBe(false);
  await act(async () => root!.render(<FailedSessionActions {...props} retryBlocker="draft" />));
  expect(container.textContent).toContain("Send or clear your draft below before trying again.");
  await act(async () => container.querySelector("button")!.click());
  expect(sends).toBe(1);
});

test("unavailable recovery options preserve the reason and usable composer", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function UnavailableOptions(): never {
    throw new Error("fixture recovery chunk unavailable");
  }
  await act(async () =>
    root!.render(
      <>
        <FailureRecoveryBoundary fallback={<p role="alert">Provider connection failed.</p>}>
          <UnavailableOptions />
        </FailureRecoveryBoundary>
        <textarea aria-label="Message" defaultValue="My preserved draft" />
      </>,
    ),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Provider connection failed.",
  );
  expect(container.querySelector("textarea")?.value).toBe("My preserved draft");
});

test("history hydration preserves a request while a distinct failure gets a fresh guard", async () => {
  let settleFirst!: (accepted: boolean) => void;
  let sends = 0;
  const props = {
    onRetry: () => {
      sends++;
      return sends === 1
        ? new Promise<boolean>((resolve) => {
            settleFirst = resolve;
          })
        : Promise.resolve(true);
    },
    retryBlocker: null,
    onChooseModel: () => {},
    modelDisabled: false,
  };
  const container = await render({ ...props, failureId: null });
  await act(async () => container.querySelector("button")!.click());
  await act(async () =>
    root!.render(<FailedSessionActions {...props} failureId="original-event" />),
  );
  expect(container.querySelector("button")!.textContent).toBe("Trying again…");
  await act(async () => root!.render(<FailedSessionActions {...props} failureId="next-event" />));
  expect(container.querySelector("button")!.disabled).toBe(false);
  await act(async () => settleFirst(true));
  expect(container.querySelector("button")!.textContent).toBe("Try again");
  await act(async () => container.querySelector("button")!.click());
  expect(sends).toBe(2);
  expect(container.querySelector("button")!.textContent).toBe("Retry requested");
});

test("credit exhaustion retains model selection without offering automatic retry", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  let opened = 0;
  await act(async () =>
    root!.render(
      <FailedSessionBanner
        creditExhausted
        workspaceId="workspace-a"
        canBuyCredits
        canConnectModel
        failure={{
          reason: "No credits available",
          failedAt: null,
          consecutiveRecoveryCount: null,
        }}
        actions={{
          onRetry: async () => true,
          retryBlocker: null,
          modelDisabled: false,
          onChooseModel: () => {
            opened++;
          },
        }}
      />,
    ),
  );
  expect(container.textContent).toContain("Buy organization credits or connect a model");
  expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
    "Buy credits",
    "Connect a model",
  ]);
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "Choose another model",
  ]);
  await act(async () => container.querySelector("button")!.click());
  expect(opened).toBe(1);
});

test("credit exhaustion hides administrative recovery links from ordinary members", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <FailedSessionBanner
        creditExhausted
        workspaceId="workspace-a"
        failure={{
          reason: "No credits available",
          failedAt: null,
          consecutiveRecoveryCount: null,
        }}
        actions={{
          onRetry: async () => true,
          retryBlocker: null,
          modelDisabled: false,
          onChooseModel: () => undefined,
        }}
      />,
    ),
  );
  expect(container.querySelectorAll("a")).toHaveLength(0);
  expect(container.textContent).toContain("Ask an organization owner or workspace admin");
  expect(container.textContent).toContain("Choose another model");
});

test("shared composer blockers disable Try again and explain the actual unresolved choice", async () => {
  const ready = {
    uploadPending: false,
    repositoryError: null,
    policyValid: true,
    variableSetBlocked: false,
    personalDecision: false,
    personalLoading: false,
  };
  let sends = 0;
  const props = {
    onRetry: async () => {
      sends++;
      return true;
    },
    retryBlocker: "draft" as const,
    onChooseModel: () => {},
    modelDisabled: false,
  };
  const container = await render(props);
  for (const [change, expected] of [
    [{ uploadPending: true }, "upload"],
    [{ repositoryError: "Repository access expired" }, "Repository access expired"],
    [{ repositoryError: "" }, "repository access"],
    [{ policyValid: false }, "supported model"],
    [{ variableSetBlocked: true }, "Variable Sets"],
    [{ personalDecision: true }, "personal resource attachment"],
    [{ personalLoading: true }, "personal resource access"],
  ] as const) {
    const input = { ...ready, ...change };
    await act(async () =>
      root!.render(
        <FailedSessionActions
          {...props}
          composerBlocker={getComposerSendBlocker(input)}
          repositoryError={input.repositoryError}
        />,
      ),
    );
    expect(container.querySelector("button")!.disabled).toBe(true);
    expect(container.textContent).toContain(expected);
    await act(async () => container.querySelector("button")!.click());
  }
  expect(sends).toBe(0);
});

test("retry respects deliberate pause and control permission without hiding model selection", async () => {
  let retries = 0;
  let models = 0;
  const props = {
    onRetry: async () => {
      retries++;
      return true;
    },
    retryBlocker: "paused" as const,
    onChooseModel: () => {
      models++;
    },
    modelDisabled: false,
  };
  const container = await render(props);
  for (const [retryBlocker, reason] of [
    ["paused", "Resume the paused session"],
    ["permission", "do not have permission"],
  ] as const) {
    await act(async () =>
      root!.render(<FailedSessionActions {...props} retryBlocker={retryBlocker} />),
    );
    const [retry, model] = [...container.querySelectorAll("button")];
    expect(retry!.disabled).toBe(true);
    expect(container.textContent).toContain(reason);
    await act(async () => {
      retry!.click();
      model!.click();
    });
  }
  expect(retries).toBe(0);
  expect(models).toBe(2);
});

test("transport failure leaves one retry action and never creates a message bubble", async () => {
  let calls = 0;
  const container = await render({
    onRetry: async () => {
      calls++;
      if (calls === 1) throw new Error("lost connection");
      return true;
    },
    retryBlocker: null,
    onChooseModel: () => {},
    modelDisabled: false,
  });
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("same request");
  expect(container.querySelector("button")!.textContent).toBe("Try again");
  await act(async () => container.querySelector("button")!.click());
  expect(calls).toBe(2);
  expect(container.querySelector("button")!.textContent).toBe("Retry requested");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("unsupported recovery explains the safe next step without automatic investigation", async () => {
  const container = await render({
    onRetry: async () => {
      throw new OpenGeniApiError(409, "Unsupported failure", { code: "RETRY_UNSUPPORTED_FAILURE" });
    },
    retryBlocker: null,
    onChooseModel: () => {},
    modelDisabled: false,
  });
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "This failure cannot be retried safely. Send a new message below.",
  );
});
