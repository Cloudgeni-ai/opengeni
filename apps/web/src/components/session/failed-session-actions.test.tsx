import { FailureRecoveryBoundary } from "./failure-recovery-boundary";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FailedSessionActions } from "./failed-session-actions";

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
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
    continueBlockedReason: null,
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
    continueBlockedReason: null as string | null,
    onChooseModel: () => {},
    modelDisabled: false,
  };
  const container = await render(props);
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be added");
  expect(container.querySelector("button")!.disabled).toBe(false);
  await act(async () =>
    root!.render(
      <FailedSessionActions
        {...props}
        continueBlockedReason="Send your draft below to continue."
      />,
    ),
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
    continueBlockedReason: null,
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
