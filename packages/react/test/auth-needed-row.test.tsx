import { describe, expect, test } from "bun:test";
import { AuthNeededRow, type AuthNeededRecoveryOptions } from "../src/components/auth-needed-row";
import type { AuthNeededItem } from "../src/timeline/types";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const GMAIL = "gmailmcp.googleapis.com";

function stepUp(overrides: Partial<AuthNeededItem> = {}): AuthNeededItem {
  return {
    kind: "auth-needed",
    id: "card-1",
    turnId: "turn-1",
    serverId: "gmail",
    providerDomain: GMAIL,
    connectionId: "conn-1",
    reason: "insufficient_scope",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    resource: null,
    toolName: "batch_modify_messages",
    authorizationUrl: null,
    occurredAt: "2026-11-19T12:40:00.000Z",
    ...overrides,
  };
}

function button(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector("button");
}

describe("AuthNeededRow", () => {
  test("a service's card shows its own logo even when the catalog has none for it", async () => {
    // The chat's resolver knows only catalog logos; Gmail has none there.
    const rendered = await renderComponent(
      <AuthNeededRow item={stepUp()} resolveProviderLogo={() => null} />,
    );
    const logo = rendered.container.querySelector("img");
    expect(logo).not.toBeNull();
    expect(rendered.container.textContent).not.toContain("GM");
    await rendered.unmount();
    // The same for its integration platform's domain.
    const viaPlatform = await renderComponent(
      <AuthNeededRow item={stepUp({ providerDomain: "nango:gmail" })} />,
    );
    expect(viaPlatform.container.querySelector("img")).not.toBeNull();
    await viaPlatform.unmount();
  });

  test("a step-up names the action, waits for the provider, then says it is allowed", async () => {
    let finish!: (value: { outcome: "done" }) => void;
    const calls: AuthNeededItem[] = [];
    const rendered = await renderComponent(
      <AuthNeededRow
        item={stepUp()}
        onReconnect={(item) => {
          calls.push(item);
          return new Promise((resolve) => {
            finish = resolve;
          });
        }}
      />,
    );
    const text = () => rendered.container.textContent ?? "";
    expect(text()).toContain("Allow Opengeni to organize your Gmail");
    expect(text()).toContain("marking mail as read");
    expect(button(rendered.container)?.textContent).toBe("Allow in Google");
    await actRun(() => button(rendered.container)!.click());
    expect(calls).toHaveLength(1);
    expect(button(rendered.container)?.textContent).toBe("Waiting for Google…");
    await actRun(() => finish({ outcome: "done" }));
    await flush();
    expect(button(rendered.container)).toBeNull();
    expect(text()).toContain("Allowed");
    // Done: no further action, no "after you allow it" hint.
    expect(text()).not.toContain("After you allow it");
    await rendered.unmount();
  });

  test("moving the card (pinned, then back in the timeline) keeps the consent going", async () => {
    const signals: AbortSignal[] = [];
    const onReconnect = (_item: AuthNeededItem, options?: AuthNeededRecoveryOptions) => {
      signals.push(options!.signal);
      return new Promise<undefined>((_resolve, reject) => {
        options!.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    const card = stepUp({ id: "card-moves" });
    const pinned = await renderComponent(<AuthNeededRow item={card} onReconnect={onReconnect} />);
    await actRun(() => button(pinned.container)!.click());
    await pinned.unmount();
    expect(signals[0]!.aborted).toBe(false);
    // Pressing the same card where it shows now starts over, once.
    const inTimeline = await renderComponent(
      <AuthNeededRow item={card} onReconnect={onReconnect} />,
    );
    await actRun(() => button(inTimeline.container)!.click());
    await flush();
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    await inTimeline.unmount();
  });

  test("pressing again while waiting starts over instead of staying stuck", async () => {
    const signals: AbortSignal[] = [];
    const rendered = await renderComponent(
      <AuthNeededRow
        item={stepUp()}
        onReconnect={(_item, options?: AuthNeededRecoveryOptions) => {
          signals.push(options!.signal);
          return new Promise<undefined>((_resolve, reject) => {
            options!.signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }}
      />,
    );
    await actRun(() => button(rendered.container)!.click());
    expect(button(rendered.container)?.disabled).toBe(false);
    await actRun(() => button(rendered.container)!.click());
    await flush();
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    // The superseded run never shows a failure.
    expect(rendered.container.textContent).not.toContain("Couldn't start");
    expect(button(rendered.container)?.textContent).toBe("Waiting for Google…");
    await rendered.unmount();
  });

  test("a card the chat recorded as finished offers nothing again", async () => {
    const rendered = await renderComponent(
      <AuthNeededRow item={stepUp({ setupFinished: true })} onReconnect={() => undefined} />,
    );
    expect(button(rendered.container)).toBeNull();
    expect(rendered.container.textContent).toContain("Allowed");
    await rendered.unmount();
  });

  test("an earlier copy of the same access request is not shown again", async () => {
    const rendered = await renderComponent(
      <AuthNeededRow item={stepUp({ askedAgainLater: true })} onReconnect={() => undefined} />,
    );
    expect(rendered.container.textContent).toBe("");
    await rendered.unmount();
  });
});
