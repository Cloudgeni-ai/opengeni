import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionUsageLimit } from "@opengeni/sdk/session-usage-limits";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { Session } from "@/types";

const workspaceId = "00000000-0000-4000-8000-000000000201";
const sessionId = "2f1c6a52-6b1e-4f43-9d55-1c0c2f7e8a10";

function usage(overrides: Partial<SessionUsageLimit> = {}): SessionUsageLimit {
  return {
    basis: "model_api_equivalent_v1",
    rootSessionId: sessionId,
    inherited: false,
    status: "within",
    limitMicros: 50_000_000,
    usedMicros: 12_340_000,
    version: 3,
    usageRevision: 7,
    history: "complete",
    coverage: "complete",
    pricedCalls: 4,
    freeCalls: 0,
    unpricedCalls: 0,
    updatedAt: "2026-10-13T08:00:00.000Z",
    ...overrides,
  } as SessionUsageLimit;
}

let current = usage();
const getSessionUsageLimit = mock(async () => current);
const setSessionUsageLimit = mock(
  async (_ws: string, _id: string, request: { limitMicros: number | null }) => ({
    ...current,
    limitMicros: request.limitMicros,
    version: current.version + 1,
  }),
);
const toastSuccess = mock((_title: string, _options?: unknown) => 0);
const context = {
  // A fresh client per test keeps the shared usage store apart.
  client: { getSessionUsageLimit, setSessionUsageLimit } as object,
  accessContext: {
    subjectId: "user-1",
    accountGrants: [],
    workspaceGrants: [{ workspaceId, permissions: ["sessions:control"] }],
  },
  clientConfig: { sessionUsageLimits: { enabled: true } } as {
    sessionUsageLimits?: { enabled: boolean };
  },
};
mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({
  toast: Object.assign(() => 0, { error: () => 0, success: toastSuccess }),
}));
const { SessionUsageLimitSection } = await import("./session-usage-limit-section");
const { UsageLimitMenuBody } = await import("./new-session-settings-menu");

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => undefined;
  (globalThis as { crypto: Crypto }).crypto.randomUUID ??= () =>
    "11111111-1111-4111-8111-111111111111";
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

let root: Root | null = null;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: sessionId,
    workspaceId,
    parentSessionId: null,
    usageLimit: current,
    ...overrides,
  } as unknown as Session;
}

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function render(node: React.ReactNode) {
  context.client = { getSessionUsageLimit, setSessionUsageLimit };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  await settle();
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
    const props = (
      input as unknown as Record<
        string,
        { onChange?: (event: { target: HTMLInputElement }) => void }
      >
    )[reactPropsKey ?? ""];
    props?.onChange?.({ target: input });
  });
}

test("within the limit: the amount, the one explanation and Change", async () => {
  current = usage();
  await render(<SessionUsageLimitSection session={session()} />);
  const text = container.textContent ?? "";
  expect(text).toContain("Usage limit");
  expect(text).toContain("$12.34 of $50.00");
  expect(text).toContain("API-equivalent model usage for this chat and its agents.");
  expect(text).not.toMatch(/credit|monthly|reset/i);
  expect(button("Change")).toBeTruthy();
});

test("save sends the version and a fresh operation, closes and returns focus to Change", async () => {
  current = usage();
  setSessionUsageLimit.mockClear();
  toastSuccess.mockClear();
  await render(<SessionUsageLimitSection session={session()} goalPausedAtLimit />);
  await act(async () => button("Change").click());
  const input = container.querySelector<HTMLInputElement>("input[inputmode=decimal]")!;
  expect(input.value).toBe("50");
  await typeInto(input, "80");
  await act(async () => button("Save").click());
  await settle();
  expect(setSessionUsageLimit).toHaveBeenCalledTimes(1);
  const request = setSessionUsageLimit.mock.calls[0]![2] as {
    limitMicros: number;
    expectedVersion: number;
    operationId: string;
  };
  expect(request.limitMicros).toBe(80_000_000);
  expect(request.expectedVersion).toBe(3);
  expect(request.operationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(toastSuccess.mock.calls[0]).toEqual([
    "Usage limit set to $80.00",
    { description: "Resume the goal to continue." },
  ]);
  expect(container.querySelector("[data-usage-limit-editor]")).toBeNull();
  expect(document.activeElement?.textContent).toBe("Change");
});

test("a stale version keeps the draft, rereads and says so", async () => {
  current = usage();
  getSessionUsageLimit.mockClear();
  setSessionUsageLimit.mockImplementationOnce(async () => {
    throw Object.assign(new Error("Opengeni API 409: conflict"), {
      status: 409,
      code: "conflict",
      details: { code: "session_usage_limit_conflict" },
    });
  });
  await render(<SessionUsageLimitSection session={session()} />);
  const readsBefore = getSessionUsageLimit.mock.calls.length;
  await act(async () => button("Change").click());
  const input = container.querySelector<HTMLInputElement>("input[inputmode=decimal]")!;
  await typeInto(input, "75");
  await act(async () => button("Save").click());
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Someone changed this limit",
  );
  expect(container.querySelector<HTMLInputElement>("input[inputmode=decimal]")!.value).toBe("75");
  expect(getSessionUsageLimit.mock.calls.length).toBeGreaterThan(readsBefore);
});

test("preparing and partial usage never read as $0", async () => {
  current = usage({ status: "preparing", usedMicros: null, history: "preparing" });
  await render(<SessionUsageLimitSection session={session()} />);
  expect(container.textContent).toContain("Preparing usage");
  expect(container.textContent).toContain("Pause at $50.00");
  expect(container.textContent).not.toContain("$0.00");
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  current = usage({ unpricedCalls: 2, coverage: "partial", usedMicros: 60_000_000 });
  await render(<SessionUsageLimitSection session={session()} />);
  expect(container.textContent).toContain("At least $60.00 of $50.00");
  expect(container.textContent).toContain("Reached");
  expect(container.textContent).toContain("no known price");
});

test("a sub-agent shows the main task's limit read-only with a link to it", async () => {
  const rootId = "3a2b1c00-0000-4000-8000-000000000301";
  current = usage({ inherited: true, rootSessionId: rootId });
  await render(
    <SessionUsageLimitSection
      session={session({ id: "child-1", parentSessionId: rootId } as Partial<Session>)}
    />,
  );
  expect(container.textContent).toContain("Set on the main task");
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    `/workspaces/${workspaceId}/sessions/${rootId}`,
  );
  expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Change")).toBe(
    false,
  );
});

test("without permission to run the chat it is read-only", async () => {
  current = usage();
  context.accessContext.workspaceGrants = [{ workspaceId, permissions: [] }];
  try {
    await render(<SessionUsageLimitSection session={session()} />);
    expect(container.textContent).toContain("needs permission to run this chat");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Change")).toBe(
      false,
    );
  } finally {
    context.accessContext.workspaceGrants = [{ workspaceId, permissions: ["sessions:control"] }];
  }
});

test("with new limits turned off, only removing a limit is possible", async () => {
  current = usage();
  context.clientConfig = { sessionUsageLimits: { enabled: false } };
  try {
    await render(<SessionUsageLimitSection session={session()} />);
    await act(async () => button("Change").click());
    const pauseAt = [...container.querySelectorAll<HTMLElement>("[role=radio], button")].find(
      (candidate) => candidate.textContent === "Pause at",
    )!;
    expect(
      pauseAt.getAttribute("aria-disabled") === "true" || pauseAt.hasAttribute("disabled"),
    ).toBe(true);
  } finally {
    context.clientConfig = { sessionUsageLimits: { enabled: true } };
  }
});

test("an older server hides the section", async () => {
  current = usage();
  context.clientConfig = {};
  try {
    await render(<SessionUsageLimitSection session={session()} />);
    expect(container.querySelector("[data-session-usage-limit]")).toBeNull();
  } finally {
    context.clientConfig = { sessionUsageLimits: { enabled: true } };
  }
});

test("new chat: Pause at reveals a labelled dollar input with a described error", async () => {
  function Harness() {
    const [value, setValue] = useState<{ kind: "none" } | { kind: "limit"; text: string }>({
      kind: "none",
    });
    return (
      <UsageLimitMenuBody
        presentation="dialog"
        value={value}
        disabled={false}
        onChange={setValue}
      />
    );
  }
  await render(<Harness />);
  expect(container.querySelector("input")).toBeNull();
  await act(async () => button("Pause at an amount").click());
  await settle();
  const input = container.querySelector<HTMLInputElement>("input")!;
  expect(input.getAttribute("inputmode")).toBe("decimal");
  const label = container.querySelector(`label[for="${input.id}"]`);
  expect(label?.textContent).toBe("Limit in US dollars");
  expect(document.activeElement).toBe(input);
  await typeInto(input, "12.345");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const describedBy = input.getAttribute("aria-describedby")!.split(" ");
  expect(document.getElementById(describedBy[0]!)?.textContent).toContain("up to 2 decimals");
  expect(container.textContent).toContain("It's not your bill");
});
