import { describe, expect, test } from "bun:test";
import type { AgentMessageItem, UserMessageItem } from "../src";
import { MessageTimeline } from "../src/components/message-timeline";
import { registerDom, renderComponent } from "./render-hook";

registerDom();

const user = {
  kind: "user-message",
  id: "user-1",
  text: "keep me",
  resources: [],
  occurredAt: "2026-01-01T00:00:00.000Z",
} as unknown as UserMessageItem;
const agent = {
  kind: "agent-message",
  id: "agent-1",
  text: "hide me",
  streaming: false,
  occurredAt: "2026-01-01T00:00:01.000Z",
} as AgentMessageItem;

describe("MessageTimeline shouldRenderItem", () => {
  test("renders every item by default", async () => {
    const r = await renderComponent(<MessageTimeline items={[user, agent]} />);
    expect(r.container.textContent).toContain("keep me");
    expect(r.container.textContent).toContain("hide me");
    await r.unmount();
  });

  test("leaves out items the host declines", async () => {
    const r = await renderComponent(
      <MessageTimeline items={[user, agent]} shouldRenderItem={(item) => item.id !== "agent-1"} />,
    );
    expect(r.container.textContent).toContain("keep me");
    expect(r.container.textContent).not.toContain("hide me");
    await r.unmount();
  });
});
