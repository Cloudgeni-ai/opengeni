import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  ClaimClaudeLimitResetRequest,
  ClaimClaudeLimitResetResponse,
  ClaudeLimitResetClaim,
  ClaudeLimitResetGrant,
  ClaudeSubscriptionUsage,
} from "@opengeni/sdk";

// The Radix dialog is a portal; this inline stand-in keeps its contract.
mock.module("@opengeni/react/ui/confirm-dialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    children,
    confirmLabel,
    onOpenChange,
    onConfirm,
  }: {
    open: boolean;
    title: ReactNode;
    children?: ReactNode;
    confirmLabel: string;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => Promise<void | boolean>;
  }) =>
    open ? (
      <div role="dialog">
        <p>{title}</p>
        {children}
        <button
          type="button"
          data-confirm
          onClick={() => {
            void (async () => {
              const result = await onConfirm();
              if (result !== false) onOpenChange(false);
            })();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));
const toasts: Array<[string, string, string | undefined]> = [];
mock.module("sonner", () => ({
  toast: {
    success: (title: string, options?: { description?: string }) =>
      toasts.push(["success", title, options?.description]),
    error: (title: string, options?: { description?: string }) =>
      toasts.push(["error", title, options?.description]),
  },
}));

const {
  ClaudeLimitResetDialog,
  ClaudeLimitResetsSection,
  ClaudeUseResetButton,
  claudeClaimOutcome,
  useClaudeLimitResetClaim,
} = await import("./claude-limit-resets");

let root: Root, container: HTMLDivElement;
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  toasts.length = 0;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());

const NOW = Date.parse("2026-11-11T08:00:00Z");
const weekly: ClaudeLimitResetGrant = {
  id: "full-reset-2611",
  label: "One full limit reset (November 2026)",
  type: "weekly",
  kind: "weekly",
  resetsTotal: 1,
  resetsLeft: 1,
  startsAt: "2026-11-10T21:30:00.000Z",
  endsAt: "2099-12-10T22:00:00.000Z",
  clears: ["seven_day", "seven_day_overage_included"],
  paused: false,
  usableNow: true,
  useRequiresLimit: false,
  givesBackWeekly: false,
  percentUsed: { seven_day: 100 },
  blocking: [],
  unavailableReason: null,
};
const fable: ClaudeLimitResetGrant = {
  ...weekly,
  id: "launch-2610-fable",
  label: "New model launch: one Fable reset",
  type: "full",
  kind: "fable",
  clears: ["seven_day_overage_included"],
  usableNow: false,
  givesBackWeekly: true,
  blocking: ["seven_day"],
  unavailableReason: "blocked_seven_day",
};
const usage = (grants: ClaudeLimitResetGrant[]): ClaudeSubscriptionUsage => ({
  connected: true,
  credentialVersion: 1,
  windows: [],
  observedAt: null,
  source: null,
  refreshStatus: "available",
  refreshCheckedAt: null,
  limitResets: {
    eligible: true,
    ineligibleReason: null,
    atLimit: grants.length > 1,
    exhausted: grants.length > 1 ? ["seven_day"] : [],
    grants,
    nextGrantId: null,
    weeklyResetsAt: null,
    cooldownUntil: null,
    observedAt: "2026-11-11T07:59:00.000Z",
  },
});
const answer = (claim: Partial<ClaudeLimitResetClaim>): ClaudeLimitResetClaim => ({
  result: "reset",
  reason: null,
  resetsLeft: 0,
  cleared: [],
  weeklyResetsAt: null,
  cooldownUntil: null,
  retryable: false,
  ...claim,
});

function Harness({
  value,
  claim,
  record,
  canManage = true,
}: {
  value: ClaudeSubscriptionUsage;
  claim: (request: ClaimClaudeLimitResetRequest) => Promise<ClaimClaudeLimitResetResponse>;
  record: (usage: ClaudeSubscriptionUsage) => void;
  canManage?: boolean;
}) {
  const state = useClaudeLimitResetClaim({ claim, beginRecord: () => record });
  return (
    <>
      <ClaudeLimitResetsSection
        usage={value}
        renderAction={
          canManage
            ? (grant, blocked) => (
                <ClaudeUseResetButton grant={grant} blocked={blocked} state={state} />
              )
            : undefined
        }
      />
      {canManage ? <ClaudeLimitResetDialog state={state} /> : null}
    </>
  );
}

const useButtons = () =>
  [...container.querySelectorAll("button")].filter((b) => b.textContent === "Use reset");
async function useFirstReset() {
  await act(async () => useButtons()[0]!.click());
  const confirm = container.querySelector<HTMLButtonElement>("[data-confirm]");
  expect(confirm).not.toBeNull();
  await act(async () => {
    confirm!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("only usable grants get a Use reset button, and only for people who manage the account", async () => {
  const claim = mock(async () => ({ claim: answer({}), usage: usage([]) }));
  await act(async () =>
    root.render(<Harness value={usage([fable, weekly])} claim={claim} record={() => {}} />),
  );
  const rows = [...container.querySelectorAll('[role="listitem"]')];
  expect(rows.map((row) => row.querySelector("button")?.textContent ?? null)).toEqual([
    "Use reset",
    null,
  ]);
  expect(rows[0]!.getAttribute("data-grant")).toBe("full-reset-2611");
  await act(async () =>
    root.render(
      <Harness value={usage([fable, weekly])} claim={claim} record={() => {}} canManage={false} />,
    ),
  );
  expect(useButtons()).toHaveLength(0);
  expect(claim).not.toHaveBeenCalled();
});

test("a confirmed claim sends the grant, records the usage read after it and says what it cleared", async () => {
  const after = usage([fable]);
  const claim = mock(async (_request: ClaimClaudeLimitResetRequest) => ({
    claim: answer({ cleared: ["seven_day"] }),
    usage: after,
  }));
  const recorded: ClaudeSubscriptionUsage[] = [];
  await act(async () =>
    root.render(
      <Harness
        value={usage([fable, weekly])}
        claim={claim}
        record={(value) => recorded.push(value)}
      />,
    ),
  );
  await act(async () => useButtons()[0]!.click());
  expect(container.querySelector('[role="dialog"]')!.textContent).toContain(
    "Use this limit reset?",
  );
  expect(container.querySelector('[role="dialog"]')!.textContent).toContain(
    "One full limit reset (November 2026)",
  );
  expect(claim).not.toHaveBeenCalled();
  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-confirm]")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(claim).toHaveBeenCalledTimes(1);
  expect(claim.mock.calls[0]![0].grantId).toBe("full-reset-2611");
  expect(claim.mock.calls[0]![0].requestId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  expect(recorded).toEqual([after]);
  expect(toasts).toEqual([["success", "Limit reset used", "Claude cleared the weekly limit."]]);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

test("a retry after an unsettled answer or a failed request reuses the request id", async () => {
  const outcomes: Array<() => ClaimClaudeLimitResetResponse> = [
    () => ({ claim: answer({ result: "error", retryable: true }), usage: usage([fable, weekly]) }),
    () => {
      throw new Error("network down");
    },
    () => ({ claim: answer({}), usage: usage([fable]) }),
    () => ({ claim: answer({ result: "already_used" }), usage: usage([fable]) }),
  ];
  const claim = mock(async (_request: ClaimClaudeLimitResetRequest) => outcomes.shift()!());
  await act(async () =>
    root.render(<Harness value={usage([fable, weekly])} claim={claim} record={() => {}} />),
  );
  await useFirstReset();
  // The failed request keeps the dialog open; confirm again from it.
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await useFirstReset();
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-confirm]")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // Settled: the next claim of this grant is a new request.
  await useFirstReset();
  const ids = claim.mock.calls.map(([request]) => request.requestId);
  expect(ids).toHaveLength(4);
  expect(new Set(ids.slice(0, 3)).size).toBe(1);
  expect(ids[3]).not.toBe(ids[0]);
  expect(toasts.map(([kind, title]) => [kind, title])).toEqual([
    ["error", "Couldn't confirm the reset"],
    ["error", "Couldn't confirm the reset"],
    ["success", "Limit reset used"],
    ["error", "This reset was already used"],
  ]);
});

test("each claim answer reads plainly and never as success unless Claude reset the limit", () => {
  const cases: Array<[Partial<ClaudeLimitResetClaim>, boolean, string]> = [
    [{ result: "reset" }, true, "Limit reset used"],
    [{ result: "already_used" }, false, "This reset was already used"],
    [{ result: "not_limited" }, false, "Nothing to reset"],
    [{ result: "cooldown", cooldownUntil: "2026-11-11T09:00:00Z" }, false, "Not yet"],
    [{ result: "ineligible", reason: "not_at_wall" }, false, "Claude won't use this reset now"],
    [{ result: "unavailable" }, false, "This reset isn't available now"],
    [{ result: "rate_limited", retryable: true }, false, "Claude is busy"],
    [{ result: "auth_error", retryable: true }, false, "Couldn't reach Claude with this account"],
    [{ result: "auth_error" }, false, "This sign-in can't use resets"],
    [{ result: "error", retryable: true }, false, "Couldn't confirm the reset"],
    [{ result: "error" }, false, "Couldn't use the reset"],
  ];
  for (const [claim, ok, title] of cases) {
    const outcome = claudeClaimOutcome(answer(claim), weekly, NOW);
    expect([claim.result, outcome.ok, outcome.title]).toEqual([claim.result, ok, title]);
  }
  expect(claudeClaimOutcome(answer({ cleared: [] }), fable, NOW).description).toBe(
    "Claude cleared the Fable limit.",
  );
  expect(claudeClaimOutcome(answer({ result: "cooldown" }), weekly, NOW).description).toContain(
    "It wasn't used.",
  );
});
