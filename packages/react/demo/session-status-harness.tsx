// A chat's real header status (Working, Waiting on a person, Done, Failed) and
// its real Linked list, with fixture data and no API.
//   ?theme=light|dark
import type { Session, SessionLinkWithStatus } from "@opengeni/sdk";
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { SessionHeader } from "@opengeni/react/app/components/rail/session-header";
import { LinkedList } from "@opengeni/react/app/components/session/linked-panel";
import { MockOpenGeniClient } from "./mock";
import "./agent-settings.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const dark = new URLSearchParams(window.location.search).get("theme") !== "light";
const since = "2026-11-20T10:00:00.000Z";

function chat(
  title: string,
  status: Session["status"],
  waitingOn: Session["waitingOn"] = null,
): Session {
  return {
    id: `session-${title}`,
    workspaceId: WORKSPACE_ID,
    initialMessage: title,
    title,
    titleSource: "manual",
    parentSessionId: null,
    model: "codex/gpt-5.6-sol",
    reasoningEffort: "high",
    latencyMode: "standard",
    metadata: {},
    status,
    pinned: false,
    waitingOn,
    effectiveControl: {
      state: "active",
      directState: "active",
      primaryBlocker: null,
      additionalBlockerCount: 0,
    },
  } as unknown as Session;
}

const chats = [
  chat("Fix the checkout rounding bug", "running"),
  chat("Rotate the staging database password", "idle", {
    source: "agent",
    person: "Kari Nordmann",
    subjectId: null,
    reason: "Needs the new password in the vault",
    since,
  }),
  chat("Approve the invoice export", "requires_action", {
    source: "input",
    person: null,
    subjectId: "user:kari",
    reason: null,
    since,
  }),
  chat("Weekly usage report", "idle"),
  chat("Migrate the billing webhooks", "failed"),
];

function link(
  id: string,
  url: string,
  kind: SessionLinkWithStatus["kind"],
  provider: SessionLinkWithStatus["provider"],
  ref: string | null,
  title: string | null,
  status: SessionLinkWithStatus["status"],
): SessionLinkWithStatus {
  return { id, url, kind, provider, ref, title, addedBy: "agent", addedAt: since, status };
}

const links: SessionLinkWithStatus[] = [
  link(
    "1",
    "https://linear.app/acme/issue/PAY-212",
    "issue",
    "linear",
    "PAY-212",
    "Checkout rounds totals down",
    {
      state: "open",
      label: "In Progress",
      title: "Checkout rounds totals down",
      checks: null,
      review: null,
      assignee: "Kari Nordmann",
    },
  ),
  link(
    "2",
    "https://github.com/acme/shop/pull/412",
    "pull_request",
    "github",
    "acme/shop#412",
    null,
    {
      state: "open",
      label: null,
      title: "Round checkout totals half-up",
      checks: "pending",
      review: "approved",
    },
  ),
  link(
    "3",
    "https://github.com/acme/shop/pull/398",
    "pull_request",
    "github",
    "acme/shop#398",
    null,
    {
      state: "merged",
      label: null,
      title: "Add currency fixtures",
      checks: null,
      review: null,
    },
  ),
  link("4", "https://github.com/acme/shop/issues/77", "issue", "github", "acme/shop#77", null, {
    state: "open",
    label: null,
    title: "Totals differ between cart and receipt",
    checks: null,
    review: null,
  }),
  link(
    "5",
    "https://acme.slack.com/archives/C01/p1763632800000100",
    "thread",
    "slack",
    null,
    "#payments thread",
    {
      state: "unknown",
      label: null,
      title: "#payments thread",
      checks: null,
      review: null,
      replies: 3,
      lastReplyAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    },
  ),
  {
    ...link(
      "6",
      "https://linear.app/acme/issue/PAY-219",
      "issue",
      "linear",
      "PAY-219",
      "Refunds skip the currency check",
      null,
    ),
    connect: { name: "Linear", capabilityId: "linear" },
  },
];

function Preview() {
  const client = useMemo(() => new MockOpenGeniClient(), []);
  useEffect(() => {
    document.documentElement.setAttribute("data-og-theme", dark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", dark);
  }, []);
  const context = useMemo(
    () =>
      ({
        client,
        accessContext: { mode: "managed", subjectId: "user:kari", workspaceGrants: [] },
        workspaces: [],
      }) as never,
    [client],
  );
  return (
    <OpenGeniProvider client={client as never} workspaceId={WORKSPACE_ID}>
      <AppContext.Provider value={context}>
        <div className="og-root flex min-h-screen gap-6 bg-og-bg p-6 text-og-fg">
          <section data-shot="status" className="flex w-[760px] flex-col gap-3">
            {chats.map((session) => (
              <div key={session.id} className="rounded-md border border-border bg-surface">
                <SessionHeader
                  session={session}
                  ancestors={[]}
                  connectionState="live"
                  status={session.status}
                  keyAuthRequired={false}
                  onForgetAccessKey={() => undefined}
                  inspectorOpen={false}
                  onToggleInspector={() => undefined}
                  onRename={async () => null}
                  onPin={async () => null}
                />
              </div>
            ))}
          </section>
          <aside
            data-shot="linked"
            className="h-fit w-[360px] rounded-md border border-border bg-surface"
          >
            <LinkedList
              links={links}
              status="ready"
              onRemove={() => undefined}
              connectHref={() => "#connect"}
            />
          </aside>
        </div>
      </AppContext.Provider>
    </OpenGeniProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
