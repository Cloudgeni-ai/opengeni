import { getComposerSendBlocker } from "@/lib/composer-send-blocking";
import { FailureRecoveryBoundary } from "./failure-recovery-boundary";
import { afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FailedSessionActions } from "./failed-session-actions";

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
test("one Continue click sequence submits one visible follow-up and leaves delivery to its message", async () => {
  let settle!: (accepted: boolean) => void;
  const receipt = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  let sends = 0;
  let modelOpens = 0;
  const container = await render({
    onContinue: async () => {
      sends++;
      return receipt;
    },
    continuationBlocker: null,
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
  expect(continueButton!.textContent).toBe("Adding follow-up…");
  await act(async () => settle(true));
  await act(async () => continueButton!.click());
  expect(sends).toBe(1);
  expect(continueButton!.textContent).toBe("Continue requested");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("delivery status");
  await act(async () => modelButton!.click());
  expect(modelOpens).toBe(1);
});
test("failed local submission remains retryable and blocked drafts explain the reason", async () => {
  let sends = 0;
  const props = {
    onContinue: async () => {
      sends++;
      return false;
    },
    continuationBlocker: null as "draft" | null,
    onChooseModel: () => {},
    modelDisabled: false,
  };
  const container = await render(props);
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be added");
  expect(container.querySelector("button")!.disabled).toBe(false);
  await act(async () =>
    root!.render(<FailedSessionActions {...props} continuationBlocker="draft" />),
  );
  expect(container.textContent).toContain("Send your draft below to continue.");
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
    onContinue: () => {
      sends++;
      return sends === 1
        ? new Promise<boolean>((resolve) => {
            settleFirst = resolve;
          })
        : Promise.resolve(true);
    },
    continuationBlocker: null,
    onChooseModel: () => {},
    modelDisabled: false,
  };
  const container = await render({ ...props, failureId: null });
  await act(async () => container.querySelector("button")!.click());
  await act(async () =>
    root!.render(<FailedSessionActions {...props} failureId="original-event" />),
  );
  expect(container.querySelector("button")!.textContent).toBe("Adding follow-up…");
  await act(async () => root!.render(<FailedSessionActions {...props} failureId="next-event" />));
  expect(container.querySelector("button")!.disabled).toBe(false);
  await act(async () => settleFirst(true));
  expect(container.querySelector("button")!.textContent).toBe("Continue");
  await act(async () => container.querySelector("button")!.click());
  expect(sends).toBe(2);
  expect(container.querySelector("button")!.textContent).toBe("Continue requested");
});

test("credit exhaustion retains model selection without offering automatic Continue", async () => {
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
          recoveryCount: 0,
          failedTurnCount: 1,
        }}
        actions={{
          onContinue: async () => true,
          continuationBlocker: null,
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
          recoveryCount: 0,
          failedTurnCount: 1,
        }}
        actions={{
          onContinue: async () => true,
          continuationBlocker: null,
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

test("shared composer blockers disable Continue and explain the actual unresolved choice", async () => {
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
    onContinue: async () => {
      sends++;
      return true;
    },
    continuationBlocker: "draft" as const,
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
