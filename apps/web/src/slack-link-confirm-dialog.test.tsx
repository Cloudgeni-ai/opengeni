import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { SlackUserLinkAccessRequest } from "@opengeni/react/app/types";

// The Radix dialog is a portal; this inline stand-in keeps its contract.
mock.module("@opengeni/react/ui/confirm-dialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    confirmLabel,
    onOpenChange,
    onConfirm,
  }: {
    open: boolean;
    title: ReactNode;
    description?: ReactNode;
    confirmLabel: string;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => Promise<void | boolean>;
  }) =>
    open ? (
      <div role="dialog">
        <p>{title}</p>
        {description ? <p>{description}</p> : null}
        <button
          type="button"
          onClick={() => {
            void (async () => {
              const result = await onConfirm();
              if (result !== false) onOpenChange(false);
            })();
          }}
        >
          {confirmLabel}
        </button>
        <button type="button" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
      </div>
    ) : null,
}));

const { SlackLinkConfirmDialog } = await import("./routes/workspace");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const prepared: SlackUserLinkAccessRequest = {
  id: "33333333-3333-4333-8333-333333333333",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  workspaceDisplayName: "Operations",
  subjectLabel: "Ada",
  status: "prepared",
  version: 1,
  expiresAt: "2026-08-20T09:00:00.000Z",
  requestedAt: null,
  decidedAt: null,
  completedAt: null,
  createdAt: "2026-08-20T08:00:00.000Z",
  updatedAt: "2026-08-20T08:00:00.000Z",
  slackAccountLabel: "@sam in Acme Slack",
  canLink: true,
  organizationMemberLink: null,
};

function button(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === label);
}

describe("Slack link confirmation for someone who can use the workspace", () => {
  test("names the Slack account and links only after they confirm it", async () => {
    const calls = { link: 0, cancel: 0 };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = async (request: SlackUserLinkAccessRequest | null) => {
      await act(async () => {
        root.render(
          <SlackLinkConfirmDialog
            request={request}
            busy={false}
            error={null}
            onLink={async () => {
              calls.link += 1;
            }}
            onCancel={() => {
              calls.cancel += 1;
            }}
          />,
        );
        await Promise.resolve();
      });
    };

    await render(prepared);
    const text = container.textContent ?? "";
    expect(text).toContain("Link your Slack account?");
    expect(text).toContain("Link @sam in Acme Slack to your Opengeni account.");
    // Opening the link linked nothing.
    expect(calls).toEqual({ link: 0, cancel: 0 });

    await act(async () => {
      button(container, "Link account")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(calls).toEqual({ link: 1, cancel: 0 });

    await act(async () => button(container, "Cancel")!.click());
    expect(calls).toEqual({ link: 1, cancel: 1 });

    // Not offered when confirming would not link, nor once it is linked.
    for (const request of [
      { ...prepared, canLink: false },
      { ...prepared, canLink: undefined },
      { ...prepared, status: "completed" as const, version: 2, canLink: false },
      null,
    ]) {
      await render(request);
      expect(container.textContent ?? "").not.toContain("Link your Slack account?");
    }
    await act(async () => root.unmount());
  });

  test("without a name from Slack it still asks before linking", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SlackLinkConfirmDialog
          request={{ ...prepared, slackAccountLabel: null }}
          busy={false}
          error={null}
          onLink={async () => undefined}
          onCancel={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    expect(container.textContent ?? "").toContain(
      "Link this Slack account to your Opengeni account.",
    );
    await act(async () => root.unmount());
  });
});
