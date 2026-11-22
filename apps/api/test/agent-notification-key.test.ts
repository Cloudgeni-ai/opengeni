import { expect, test } from "bun:test";
import { connectionCardNoticeKey } from "@opengeni/contracts";
import { agentNotificationKey } from "../src/mcp/notification-tools";

test("an agent can't set or clear a connection card's needs-you state through its own notices", () => {
  expect(agentNotificationKey("report-ready")).toBe("report-ready");
  const card = connectionCardNoticeKey({
    providerDomain: "gmail.googleapis.com",
    connectionId: "c-1",
  });
  expect(() => agentNotificationKey(card)).toThrow("reserved for connection cards");
});
