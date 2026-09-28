import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { copyTextToClipboard } from "@opengeni/react/clipboard";
import type { CodexAccountOverview } from "@opengeni/sdk";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";

import { CodexDeviceCodePanel, ResetCreditInventory, codexUsageReadings } from "./codex-connection";
import { UsageMeter } from "./ui/usage-meter";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

function setClipboard(writeText: (value: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => false,
  });
}

describe("Codex remaining allowance meters", () => {
  test("reads percent left, weekly first, and never invents a missing window", () => {
    const now = Date.parse("2026-09-27T10:00:00Z");
    const readings = codexUsageReadings(
      {
        fiveHour: null,
        weekly: {
          used: 22,
          limit: 100,
          percent: 22,
          remaining: 78,
          resetAt: "2026-10-04T07:57:00Z",
          resetAfterSeconds: null,
          limitWindowSeconds: 604800,
        },
      },
      now,
    );
    expect(readings.map((reading) => reading.label)).toEqual(["Weekly", "5-hour"]);
    expect(readings[0]!.percent).toBe(78);
    expect(readings[0]!.resetsLabel).toMatch(/Oct/);
    expect(readings[1]!.percent).toBeNull();
    expect(codexUsageReadings(null, now).every((reading) => reading.percent === null)).toBe(true);
  });

  for (const remaining of [100, 90, 10, 0]) {
    test(`labels the meter with ${remaining}% left`, async () => {
      const window = {
        used: 100 - remaining,
        limit: 100,
        percent: 100 - remaining,
        remaining,
        resetAt: null,
        resetAfterSeconds: null,
        limitWindowSeconds: 18000,
      };
      const reading = codexUsageReadings({ fiveHour: window, weekly: null }, 0)[1]!;
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () =>
          root.render(<UsageMeter label={reading.label} percent={reading.percent} />),
        );
        const bar = container.querySelector<HTMLElement>('[role="meter"], [role="progressbar"]');
        expect(bar?.getAttribute("aria-valuenow")).toBe(String(remaining));
        expect(container.textContent).toContain(
          remaining === 0 ? "Limit reached" : `${remaining}% left`,
        );
        expect(container.textContent).not.toContain("% used");
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });
  }
});

const defaultPanelProps = {
  userCode: "ABCD-1234",
  verificationUri: "https://auth.openai.com/codex/device",
  loadClipboard: async () => ({ copyTextToClipboard }),
} satisfies ComponentProps<typeof CodexDeviceCodePanel>;

async function renderPanel(props: ComponentProps<typeof CodexDeviceCodePanel> = defaultPanelProps) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CodexDeviceCodePanel {...props} />);
  });
  return { container, root };
}

describe("CodexDeviceCodePanel", () => {
  test("copies the exact device code and confirms the action", async () => {
    const copies: string[] = [];
    let copied!: () => void;
    const copiedPromise = new Promise<void>((resolve) => {
      copied = resolve;
    });
    setClipboard(async (value) => {
      copies.push(value);
      copied();
    });
    const { container, root } = await renderPanel();

    try {
      expect(container.querySelector("[data-codex-device-code]")?.textContent).toBe("ABCD-1234");
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]');
      expect(button?.type).toBe("button");

      await act(async () => {
        button!.click();
        await copiedPromise;
        await Promise.resolve();
      });

      expect(copies).toEqual(["ABCD-1234"]);
      expect(container.querySelector('button[aria-label="Code copied"]')?.textContent).toContain(
        "Copied",
      );
      const authLink = container.querySelector<HTMLAnchorElement>("a");
      expect(authLink?.href).toBe("https://auth.openai.com/codex/device");
      expect(authLink?.target).toBe("_blank");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("clears prior success feedback when a later copy fails", async () => {
    let shouldFail = false;
    setClipboard(async () => {
      if (shouldFail) throw new Error("clipboard denied");
    });
    const { container, root } = await renderPanel();

    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click();
        await Promise.resolve();
      });
      expect(container.querySelector('button[aria-label="Code copied"]')).not.toBeNull();

      shouldFail = true;
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Code copied"]')!.click();
        await Promise.resolve();
      });

      expect(container.querySelector('button[aria-label="Code copied"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Copy code"]')?.textContent).toContain(
        "Copy code",
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("ignores an older copy completion after a newer attempt fails", async () => {
    let resolveFirst!: () => void;
    let calls = 0;
    setClipboard(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.reject(new Error("clipboard denied"));
    });
    const { container, root } = await renderPanel();

    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click();
        await Promise.resolve();
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click();
        await Promise.resolve();
      });
      expect(container.querySelector('button[aria-label="Code copied"]')).toBeNull();

      await act(async () => {
        resolveFirst();
        await Promise.resolve();
      });

      expect(calls).toBe(2);
      expect(container.querySelector('button[aria-label="Code copied"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("does not copy an expired code if it changes while the helper loads", async () => {
    let resolveLoad!: (module: {
      copyTextToClipboard: (value: string) => Promise<boolean>;
    }) => void;
    const writes: string[] = [];
    const loadClipboard = () =>
      new Promise<{ copyTextToClipboard: (value: string) => Promise<boolean> }>((resolve) => {
        resolveLoad = resolve;
      });
    const { container, root } = await renderPanel({ ...defaultPanelProps, loadClipboard });

    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click();
        await Promise.resolve();
      });
      await act(async () => {
        root.render(
          <CodexDeviceCodePanel
            {...defaultPanelProps}
            userCode="WXYZ-5678"
            loadClipboard={loadClipboard}
          />,
        );
      });
      await act(async () => {
        resolveLoad({
          copyTextToClipboard: async (value) => {
            writes.push(value);
            return true;
          },
        });
        await Promise.resolve();
      });

      expect(writes).toEqual([]);
      expect(container.querySelector("[data-codex-device-code]")?.textContent).toBe("WXYZ-5678");
      expect(container.querySelector('button[aria-label="Code copied"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("does not copy after unmount while the helper loads", async () => {
    let resolveLoad!: (module: {
      copyTextToClipboard: (value: string) => Promise<boolean>;
    }) => void;
    const writes: string[] = [];
    const loadClipboard = () =>
      new Promise<{ copyTextToClipboard: (value: string) => Promise<boolean> }>((resolve) => {
        resolveLoad = resolve;
      });
    const { container, root } = await renderPanel({ ...defaultPanelProps, loadClipboard });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click();
      await Promise.resolve();
    });
    await act(async () => root.unmount());
    await act(async () => {
      resolveLoad({
        copyTextToClipboard: async (value) => {
          writes.push(value);
          return true;
        },
      });
      await Promise.resolve();
    });

    expect(writes).toEqual([]);
    container.remove();
  });
});

describe("ResetCreditInventory", () => {
  test("explains unavailable managed-human authority without offering ownership recovery", async () => {
    const overview: CodexAccountOverview = {
      accountId: "account-unavailable",
      usage: {
        source: "none",
        fetchedAt: null,
        stale: false,
        error: null,
        value: null,
      },
      resetCredits: {
        source: "provider",
        fetchedAt: null,
        stale: false,
        error: null,
        detailState: "detailed",
        detailsComplete: true,
        availableCount: 1,
        credits: [
          {
            id: "credit-view-only",
            resetType: "codexRateLimits",
            status: "available",
            grantedAt: 1,
            expiresAt: null,
            title: "Full reset",
            description: null,
            actionable: false,
          },
        ],
      },
      canRedeem: false,
      redemptionAccess: {
        ownership: "managed_human_unavailable",
        canClaimUnownedViaReconnect: false,
      },
      canResumeRedemption: false,
      redemptions: [],
    };
    let reconnectCalls = 0;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ResetCreditInventory
            overview={overview}
            now={0}
            busy={false}
            recoveryAttempts={[]}
            onRedeem={() => undefined}
            onReconnectSameAccount={() => {
              reconnectCalls += 1;
            }}
          />,
        );
      });

      expect(container.textContent).toContain(
        "OpenGeni couldn't confirm who is signed in to this browser",
      );
      expect(container.textContent).toContain("ownership can't be claimed or changed");
      expect(container.querySelectorAll("button")).toHaveLength(0);
      expect(reconnectCalls).toBe(0);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
