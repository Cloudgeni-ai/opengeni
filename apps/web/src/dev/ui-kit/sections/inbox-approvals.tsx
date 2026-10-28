import type { InboxItem } from "@opengeni/sdk";
import { CheckIcon, XIcon } from "lucide-react";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { InboxRow } from "@/routes/inbox";

import { KitSection, StateCell, StatesGrid } from "../kit";

/* ----------------------------------------------------------------------------
   Approvals waiting in the inbox. The real inbox row, with the title and body
   the inbox projection now writes: what the action does, and where it runs.
   "Before" shows what the same approvals said when the row used the raw tool
   name (and an app action's question sat in a code chip).
   -------------------------------------------------------------------------- */

const updated = new Date(Date.now() - 2 * 3_600_000).toISOString();

function approval(id: string, title: string, body: string): InboxItem {
  return {
    id,
    workspaceId: "ws-kit",
    sessionId: "session-kit",
    sessionTitle: "Personal agent",
    kind: "approval",
    sourceKey: id,
    title,
    subtitle: "",
    body,
    facts: [],
    link: null,
    eventSequence: null,
    choices: [],
    urgency: "normal",
    status: "open",
    unread: false,
    snoozedUntil: null,
    createdAt: updated,
    updatedAt: updated,
    resolvedAt: null,
  };
}

function Row({ item, before }: { item: InboxItem; before?: boolean }) {
  return (
    <ul className="w-full">
      <InboxRow
        item={item}
        unread={false}
        title={item.title}
        body={
          before && item.body ? (
            <code className="my-0.5 inline-block max-w-full truncate rounded-[6px] bg-surface-2 px-1.5 py-0.5 align-top font-mono text-xs text-fg">
              {item.body}
            </code>
          ) : undefined
        }
        meta={[
          before ? (item.body ? null : "Approval") : item.body || "Approval",
          item.sessionTitle ?? "Untitled session",
        ].filter((part): part is string => Boolean(part))}
        when={item.updatedAt}
        actions={
          <>
            <RowButton>
              <XIcon />
              Deny
            </RowButton>
            <RowButton>
              <CheckIcon />
              Approve
            </RowButton>
          </>
        }
        menu={<DropdownMenuItem>Open session</DropdownMenuItem>}
        onOpen={() => undefined}
      />
    </ul>
  );
}

export default function InboxApprovalsSection() {
  return (
    <KitSection sectionKey="inbox-approvals">
      <StatesGrid title="After" columns={1}>
        <StateCell label="Gmail, several messages" align="stretch">
          <Row item={approval("a1", "Move 3 messages to Trash", "Gmail")} />
        </StateCell>
        <StateCell label="Outlook draft" align="stretch">
          <Row item={approval("a2", "Save a draft email", "Outlook Mail")} />
        </StateCell>
        <StateCell label="Several accounts of one integration" align="stretch">
          <Row item={approval("a3", "Create issue", "Linear · Product team")} />
        </StateCell>
        <StateCell label="App action" align="stretch">
          <Row item={approval("a4", "Invite kari@example.com to your organization?", "")} />
        </StateCell>
      </StatesGrid>
      <StatesGrid title="Before" columns={1}>
        <StateCell label="Gmail, several messages" align="stretch">
          <Row before item={approval("b1", "batch_modify_messages", "")} />
        </StateCell>
        <StateCell label="App action" align="stretch">
          <Row
            before
            item={approval(
              "b4",
              "admin_action_call",
              "Invite kari@example.com to your organization?",
            )}
          />
        </StateCell>
      </StatesGrid>
    </KitSection>
  );
}
