import { afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

mock.module("../../lib/navigation", () => ({
  Link: ({
    children,
    to,
    params,
    search,
  }: {
    children: ReactNode;
    to: string;
    params: { workspaceId: string };
    search: { section: string };
  }) => (
    <a href={`${to.replace("$workspaceId", params.workspaceId)}?section=${search.section}`}>
      {children}
    </a>
  ),
}));

const {
  OwnSubscriptionPlanNote,
  OwnSubscriptionPlanNotice,
  ownSubscriptionPlanNotice,
  ownSubscriptionPlanSentence,
  planMonthlyPrice,
} = await import("./own-subscription-plan-notice");

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
  root = undefined;
  document.body.replaceChildren();
});

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

const PRO = { key: "pro", label: "Pro", monthlyPriceMicros: 20_000_000 };
const ready = {
  credentialReadiness: {
    status: "ready" as const,
    reason: null,
    basis: "configuration" as const,
    checkedAt: null,
  },
  availability: {
    status: "available" as const,
    selectable: true,
    reason: null,
    checkedAt: null,
  },
};
const gated = { ...ready, requiredPlan: PRO };

test("plan name and price come from the catalog plan", () => {
  expect(planMonthlyPrice(PRO)).toBe("$20/month");
  expect(planMonthlyPrice({ monthlyPriceMicros: 24_500_000 })).toBe("$24.50/month");
  expect(planMonthlyPrice({ monthlyPriceMicros: null })).toBe(null);
  expect(ownSubscriptionPlanSentence(PRO)).toBe(
    "Using your own subscription needs Pro ($20/month).",
  );
  expect(
    ownSubscriptionPlanSentence({ key: "team", label: "Team", monthlyPriceMicros: 30_000_000 }),
  ).toBe("Using your own subscription needs Team ($30/month).");
});

test("a chosen model waiting for a plan says so before Send; otherwise a one-time heads-up", () => {
  // Chosen: not dismissible, whether or not the heads-up was dismissed.
  expect(
    ownSubscriptionPlanNotice({ selected: gated, models: [gated], headsUpDismissed: true }),
  ).toEqual({ plan: PRO, dismissible: false });
  // Connected earlier, another model chosen: the heads-up, until dismissed.
  expect(
    ownSubscriptionPlanNotice({ selected: ready, models: [ready, gated], headsUpDismissed: false }),
  ).toEqual({ plan: PRO, dismissible: true });
  expect(
    ownSubscriptionPlanNotice({ selected: ready, models: [ready, gated], headsUpDismissed: true }),
  ).toBe(null);
  // Nothing connected, or a plan that includes them: nothing to say.
  expect(
    ownSubscriptionPlanNotice({ selected: ready, models: [ready], headsUpDismissed: false }),
  ).toBe(null);
  // A subscription that isn't ready (signed out) isn't one the picker offers.
  expect(
    ownSubscriptionPlanNotice({
      selected: undefined,
      models: [
        {
          ...gated,
          credentialReadiness: { ...ready.credentialReadiness, status: "not_ready" as const },
        },
      ],
      headsUpDismissed: false,
    }),
  ).toBe(null);
});

test("someone who manages billing gets the price and one Upgrade action", async () => {
  const dismissed = mock(() => undefined);
  const container = await render(
    <OwnSubscriptionPlanNotice
      plan={PRO}
      workspaceId="workspace-1"
      canUpgrade
      onDismiss={dismissed}
    />,
  );
  expect(container.textContent).toContain("Using your own subscription needs Pro");
  expect(container.textContent).toContain("Pro is $20/month.");
  const links = [...container.querySelectorAll("a")];
  expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
    ["Upgrade to Pro", "/workspaces/workspace-1/organization?section=billing"],
  ]);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click(),
  );
  expect(dismissed).toHaveBeenCalledTimes(1);
});

test("anyone else is told who to ask, with no action and, for a chosen model, no dismiss", async () => {
  const container = await render(
    <OwnSubscriptionPlanNotice plan={PRO} workspaceId="workspace-1" canUpgrade={false} />,
  );
  expect(container.textContent).toContain("Ask an organization owner to upgrade to Pro.");
  expect(container.querySelector("a")).toBe(null);
  expect(container.querySelector('button[aria-label="Dismiss"]')).toBe(null);
});

test("the connect step says it in one sentence", async () => {
  const container = await render(<OwnSubscriptionPlanNote plan={PRO} />);
  expect(container.textContent).toBe("Using your own subscription needs Pro ($20/month).");
});

test("the heads-up stays dismissed for its organization once that organization is known", async () => {
  const { useDismissedNotice } = await import("../agents/agent-notices");
  window.localStorage.setItem("opengeni.notice.ownSubscriptionPlan.org-1", "dismissed");
  let latest: { dismissed: boolean; dismiss: () => void } | undefined;
  function Probe({ id }: { id: string }) {
    latest = useDismissedNotice(`ownSubscriptionPlan.${id}`);
    return null;
  }
  try {
    await render(<Probe id="unknown" />);
    expect(latest!.dismissed).toBe(false);
    // The page knew its organization only later: read again for that key.
    await act(async () => root!.render(<Probe id="org-1" />));
    expect(latest!.dismissed).toBe(true);
    await act(async () => root!.render(<Probe id="org-2" />));
    expect(latest!.dismissed).toBe(false);
    await act(async () => latest!.dismiss());
    expect(latest!.dismissed).toBe(true);
    expect(window.localStorage.getItem("opengeni.notice.ownSubscriptionPlan.org-2")).toBe(
      "dismissed",
    );
  } finally {
    window.localStorage.clear();
  }
});
