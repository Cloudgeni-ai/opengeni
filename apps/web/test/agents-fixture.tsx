// Agents UI in a browser: the production pages, chip and header with an
// in-memory client. `?view=` picks the screen; nothing reaches a server.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Agent, AgentChat, Session } from "@opengeni/sdk";
import { ChatComposer } from "@opengeni/react";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import type { AppContextValue } from "@opengeni/react/app/app-context";
import { ComposerAgentChip } from "@opengeni/react/app/components/agents/composer-agent-chip";
import { SessionSetupStrip } from "@opengeni/react/app/components/session/new-session-setup-strip";
import { SessionHeader } from "@opengeni/react/app/components/rail/session-header";
import { agentAvatar } from "../../../packages/react/src/app/lib/agent-avatar";
import {
  AgentsTestHost,
  WORKSPACE_ID,
  appContext,
  fakeAgentsClient,
  makeAgent,
  summary,
} from "../../../packages/react/test/agents-test-kit";
import { emptyAttachments, idleComposer } from "../src/dev/composer-chrome-fixtures";
import { AgentRoute, AgentsRoute, NewAgentRoute } from "../src/routes/agents";
import "../src/styles.css";

const view = new URLSearchParams(location.search).get("view") ?? "agents";
const SLACK_CONNECTION = "55555555-5555-4555-8555-555555555555";
const SECOND_CONNECTION = "66666666-6666-4666-8666-666666666666";
const SESSION_ID = "77777777-7777-4777-8777-777777777777";

const releases = makeAgent({
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  name: "Release manager",
  description: "Plans and checks our weekly releases",
  avatar: { kind: "emoji", emoji: "🚀", hue: 210 },
  origin: "slack_agent",
  instructions:
    "You run our weekly release. Check the changelog, open PRs labelled release, and the staging dashboards. Post a short go/no-go summary with links. Never deploy yourself.",
  firstMessage: "",
  memory: { enabled: true, collectionId: "c1", scope: "workspace", reviewFirst: false },
  slack: [
    {
      connectionId: SLACK_CONNECTION,
      slackTeamId: "T01",
      slackTeamName: "Acme",
      handle: "releases",
      open: false,
      enabledBySubjectId: "user-me",
      version: 1,
      createdAt: "2026-10-01T09:00:00.000Z",
      updatedAt: "2026-10-01T09:00:00.000Z",
    },
  ],
});
const onboarding = makeAgent({
  id: "aaaaaaaa-0000-4000-8000-000000000002",
  name: "Onboarding buddy",
  description: "Sets up a new teammate's tools and answers first-week questions",
  avatar: { kind: "icon", icon: "bot", hue: 140 },
  origin: "bot_template",
  instructions: "Help new teammates get set up. Be patient and concrete.",
  firstMessage:
    "Set me up: install the onboarding Skills, connect GitHub and Linear, and ask which team I'm joining.",
});
const notes = makeAgent({
  id: "aaaaaaaa-0000-4000-8000-000000000003",
  name: "Meeting notes",
  description: "Turns my call transcripts into decisions and follow-ups",
  avatar: null,
  visibility: "private",
  ownerSubjectId: "user-me",
  instructions: "Summarise transcripts into decisions, owners and dates.",
});
const duplicate = makeAgent({
  id: "aaaaaaaa-0000-4000-8000-000000000004",
  name: "Release Manager",
  description: "Old template for release checklists",
  avatar: { kind: "letters", letters: "RM", hue: 20 },
  origin: "bot_template",
  createdBySubjectId: "user-kari",
  viewer: { canEdit: false, canManageSlack: false, canOpenInSlack: false },
});
const agents: Agent[] = [releases, onboarding, notes, duplicate];

const chats: AgentChat[] = [
  {
    sessionId: "88888888-8888-4888-8888-000000000001",
    title: "Release 2026.44 go/no-go",
    visibility: "workspace",
    createdBySubjectId: "user-kari",
    source: "slack",
    slack: {
      connectionId: SLACK_CONNECTION,
      channelId: "C01",
      threadTs: "1.1",
      initiatingSlackUserId: "U01",
    },
    createdAt: "2026-10-30T09:00:00.000Z",
    updatedAt: "2026-10-30T10:00:00.000Z",
  },
  {
    sessionId: "88888888-8888-4888-8888-000000000002",
    title: "Draft the changelog for 2026.45",
    visibility: "workspace",
    createdBySubjectId: "user-me",
    source: "app",
    slack: null,
    createdAt: "2026-10-29T09:00:00.000Z",
    updatedAt: "2026-10-29T11:00:00.000Z",
  },
];

const client = fakeAgentsClient(agents, {
  chats,
  slack: {
    routingEnabled: true,
    installs: [
      {
        connectionId: SLACK_CONNECTION,
        slackTeamId: "T01",
        slackTeamName: "Acme",
        availability: releases.slack[0]!,
      },
      {
        connectionId: SECOND_CONNECTION,
        slackTeamId: "T02",
        slackTeamName: "Acme Support",
        availability: null,
      },
    ],
  },
  session: {
    title: "Weekly metrics review",
    description: "Pulls the weekly KPIs and flags anything unusual",
    avatar: { kind: "emoji", emoji: "📈", hue: 280 },
    visibility: "workspace",
  },
  yours: (agent) => agent.createdBySubjectId === "user-me",
});
// Only Release manager is in Slack, and Meeting notes has only its owner's chat.
const listInstalls = client.listAgentSlackInstalls.bind(client);
client.listAgentSlackInstalls = async (workspaceId: string, id: string) => {
  const response = await listInstalls(workspaceId, id);
  return id === releases.id
    ? response
    : {
        ...response,
        installs: response.installs.map((install) => ({ ...install, availability: null })),
      };
};
const listChats = client.listAgentChats.bind(client);
client.listAgentChats = async (workspaceId: string, id: string, request) => {
  const response = await listChats(workspaceId, id, request);
  return id === releases.id
    ? response
    : { ...response, chats: response.chats.filter((chat) => chat.source === "app") };
};
const context: AppContextValue = appContext(client, {
  workspaces: [{ id: WORKSPACE_ID, name: "Platform", kind: "shared", accountId: "account-1" }],
});

const session = {
  id: SESSION_ID,
  workspaceId: WORKSPACE_ID,
  initialMessage: "Is 2026.44 ready to ship?",
  title: "Is 2026.44 ready to ship?",
  titleSource: "auto",
  parentSessionId: null,
  model: "codex/gpt-5.6-sol",
  reasoningEffort: "high",
  latencyMode: "standard",
  metadata: {},
  status: "idle",
  pinned: false,
  effectiveControl: {
    state: "active",
    directState: "active",
    primaryBlocker: null,
    additionalBlockerCount: 0,
  },
} as unknown as Session;

function Header({ agentChat }: { agentChat: boolean }) {
  const patch = agentChat
    ? {
        agentId: releases.id,
        metadata: { slackAgent: { id: releases.id, name: releases.name } },
        createdBy: { kind: "subject", subjectId: "user-kari", label: "Kari" },
      }
    : {
        title: "Weekly metrics review",
        avatar: { kind: "emoji", emoji: "📈", hue: 280 },
        agentId: null,
      };
  return (
    <div className="border-b border-border">
      <SessionHeader
        session={{ ...session, ...patch } as Session}
        ancestors={[]}
        connectionState="live"
        status="idle"
        keyAuthRequired={false}
        onForgetAccessKey={() => undefined}
        inspectorOpen={false}
        onRename={async () => null}
        onPin={async () => null}
        onMakeAgent={() => undefined}
      />
    </div>
  );
}

function Composer() {
  const [selected, setSelected] = useState<string | null>(onboarding.id);
  const agent = agents.find((row) => row.id === selected) ?? null;
  const [message, setMessage] = useState(onboarding.firstMessage);
  return (
    <main className="mx-auto w-full max-w-3xl px-4 pt-16">
      <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight">
        What should we work on?
      </h1>
      <ChatComposer
        composer={idleComposer({
          value: message,
          setValue: setMessage,
          hasDraftContent: () => message.length > 0,
          canSend: message.trim().length > 0,
        })}
        attachments={emptyAttachments()}
        header={
          <SessionSetupStrip
            disabled={false}
            agent={
              <ComposerAgentChip
                workspaceId={WORKSPACE_ID}
                agents={agents.map(summary)}
                selection={
                  agent
                    ? { kind: "ready", id: agent.id, name: agent.name, avatar: agentAvatar(agent) }
                    : null
                }
                disabled={false}
                onSelect={(id) => {
                  setSelected(id);
                  setMessage(agents.find((row) => row.id === id)?.firstMessage ?? "");
                }}
                onBrowse={() => undefined}
              />
            }
            project={null}
            runsOn={null}
            visibility={null}
          />
        }
      />
    </main>
  );
}

function Screen() {
  switch (view) {
    case "agent":
      return <AgentRoute workspaceId={WORKSPACE_ID} agentId={releases.id} />;
    case "agent-private":
      return <AgentRoute workspaceId={WORKSPACE_ID} agentId={notes.id} />;
    case "make-agent":
      return <NewAgentRoute workspaceId={WORKSPACE_ID} sourceSessionId={SESSION_ID} />;
    case "composer":
      return <Composer />;
    case "header":
      return <Header agentChat />;
    case "header-menu":
      return <Header agentChat={false} />;
    default:
      return <AgentsRoute workspaceId={WORKSPACE_ID} />;
  }
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <AgentsTestHost context={context}>
      <div className="flex min-h-dvh min-w-0 flex-col bg-bg text-fg">
        <Screen />
      </div>
    </AgentsTestHost>
  </TooltipProvider>,
);
