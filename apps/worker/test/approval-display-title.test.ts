import { expect, test } from "bun:test";
import { withApprovalDisplayTitle } from "../src/activities/agent-turn/approval-display-title";

const gmail = (toolName: string, args: unknown) => ({
  id: "call-1",
  name: `mcp_gmail__${toolName}`,
  arguments: args,
  display: {
    toolName,
    connector: "Gmail",
    providerDomain: "gmailmcp.googleapis.com",
  },
});

test("a Gmail approval carries the title its review card shows", () => {
  const approval = gmail("batch_modify_messages", {
    messageIds: ["a", "b", "c"],
    addLabelIds: ["TRASH"],
  });
  expect(withApprovalDisplayTitle(approval)).toEqual({
    ...approval,
    display: { ...approval.display, title: "Move 3 messages to Trash" },
  });
  expect(
    (
      withApprovalDisplayTitle(
        gmail(
          "batch_modify_messages",
          JSON.stringify({ messageIds: ["a"], removeLabelIds: ["UNREAD"] }),
        ),
      ) as { display: { title: string } }
    ).display.title,
  ).toBe("Update 1 message");
});

test("other tools get a readable name; a title the tool set is kept", () => {
  expect(
    (
      withApprovalDisplayTitle({
        id: "call-2",
        name: "mcp_linear__create_issue",
        arguments: { title: "Bug" },
        display: { toolName: "create_issue", connector: "Linear" },
      }) as { display: { title: string } }
    ).display.title,
  ).toBe("Create issue");
  const titled = {
    id: "call-3",
    name: "mcp_m365__x",
    display: { toolName: "x", title: "Save a draft email" },
  };
  expect(withApprovalDisplayTitle(titled)).toBe(titled);
});

test("an approval without display details is left alone", () => {
  const bare = { id: "call-4", name: "shell", arguments: {} };
  expect(withApprovalDisplayTitle(bare)).toBe(bare);
  expect(withApprovalDisplayTitle(null)).toBe(null);
});
