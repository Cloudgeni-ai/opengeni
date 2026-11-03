import type {
  CodexAccount,
  ModelAccountChoiceOption,
  SessionModelAccountChoiceResponse,
} from "@opengeni/sdk";
import { RowList } from "@opengeni/react/ui/list-row";
import { SubscriptionUsageCell } from "@opengeni/react/app/components/models/subscription-usage";
import {
  codexAccountState,
  sharedAccountState,
  SubscriptionAccountControl,
} from "@opengeni/react/app/components/session/subscription-account-indicator";
import {
  subscriptionPlanLabel,
  subscriptionWindows,
  type SubscriptionWindowInput,
} from "@opengeni/react/app/lib/subscription-accounts";
import { ACCOUNT_COLUMNS } from "@/components/models/codex-models";
import { SubscriptionAccountRow } from "@/components/models/subscription-account-ui";

import { KitBlock, KitCanvas, KitSection } from "../kit";

/* ----------------------------------------------------------------------------
   Subscription accounts: the production session-header account control and
   the Models settings rows, fed by the production adapters
   (lib/subscription-accounts). Only the data is a fixture: Claude accounts on
   Pro, Max and verified Ultra (no 5h window), ChatGPT Plus, Pro (no 5h
   window) and Free, and SuperGrok. Open each control to see its menu.
   -------------------------------------------------------------------------- */

const HOUR = 3_600_000;

type Fixture = {
  id: string;
  email: string;
  plan: string;
  windows: Array<[id: string, used: number, resetHours: number | null]>;
  status?: string;
};

const CLAUDE: Fixture[] = [
  {
    id: "c1",
    email: "alex.morgan@example.test",
    plan: "claude_pro",
    windows: [
      ["five_hour", 36, 2.4],
      ["seven_day", 62, 70],
    ],
  },
  {
    id: "c2",
    email: "sam.longername.lindqvist@example.test",
    plan: "claude_max_20x",
    windows: [
      ["seven_day", 24, 101],
      ["seven_day_fable", 41, 101],
    ],
  },
  {
    id: "c3",
    email: "research.lab@example.test",
    plan: "claude_max_5x",
    windows: [
      ["five_hour", 100, 1.2],
      ["seven_day", 72, 30],
      ["seven_day_fable", 18, 30],
    ],
  },
  {
    id: "c4",
    email: "kim@example.test",
    plan: "claude_max",
    windows: [
      ["five_hour", 3, 4.6],
      ["seven_day", 54, 52],
    ],
  },
  {
    id: "c5",
    email: "build.agent.ultra@example.test",
    plan: "claude_pro",
    windows: [],
    status: "needs_relogin",
  },
];

const CODEX: Fixture[] = [
  {
    id: "o1",
    email: "ops@example.test",
    plan: "plus",
    windows: [
      ["five_hour", 58, 3.1],
      ["seven_day", 33, 96],
    ],
  },
  { id: "o2", email: "research@example.test", plan: "pro", windows: [["seven_day", 12, 130]] },
  { id: "o3", email: "intern@example.test", plan: "free", windows: [["seven_day", 91, 40]] },
];

const GROK: Fixture[] = [
  {
    id: "x1",
    email: "grok@example.test",
    plan: "SuperGrok Heavy",
    windows: [["billing", 35, 260]],
  },
  {
    id: "x2",
    email: "grok2@example.test",
    plan: "SuperGrok Heavy",
    windows: [["billing", 8, 260]],
  },
];

function iso(now: number, hours: number | null) {
  return hours === null ? null : new Date(now + hours * HOUR).toISOString();
}

function option(provider: string, fixture: Fixture, now: number): ModelAccountChoiceOption {
  return {
    provider,
    connectionId: fixture.id,
    label: fixture.email,
    accountEmail: fixture.email,
    planType: fixture.plan,
    status: fixture.status ?? "active",
    personal: false,
    source: "organization",
    allowedModelIds: null,
    choosable: !fixture.status,
    refusal: fixture.status ? "inactive" : null,
    usage: fixture.windows.length
      ? {
          observedAt: new Date(now - 4 * 60_000).toISOString(),
          source: "response_headers",
          exhaustedKind: null,
          exhaustedUntil: null,
          windows: fixture.windows.map(([id, used, hours]) => ({
            id,
            usedPercent: used,
            resetsAt: iso(now, hours),
            status: used >= 100 ? "exhausted" : used >= 90 ? "warning" : "ok",
          })),
        }
      : null,
  } as ModelAccountChoiceOption;
}

function sharedState(provider: string, fixtures: Fixture[], chosen: string, now: number) {
  const choice: SessionModelAccountChoiceResponse = {
    binding: { provider, connectionId: chosen, choice: "explicit" },
    bindings: [{ provider, connectionId: chosen, choice: "explicit" }],
    accounts: fixtures.map((fixture) => option(provider, fixture, now)),
    personal: { connectionsAllowed: true, fallbackAllowed: false, fallbackOptIn: false },
  } as SessionModelAccountChoiceResponse;
  return sharedAccountState(
    provider,
    {
      loading: false,
      choosing: false,
      choosingTarget: undefined,
      appliedTo: null,
      mutationError: null,
      choice,
    },
    undefined,
  );
}

function codexState(now: number) {
  const reading = (fixture: Fixture, id: string) => {
    const window = fixture.windows.find(([windowId]) => windowId === id);
    return window
      ? { percent: window[1], remaining: 100 - window[1], resetAt: iso(now, window[2]) }
      : null;
  };
  const accounts = CODEX.map(
    (fixture) =>
      ({
        id: fixture.id,
        source: "organization",
        label: fixture.email,
        email: fixture.email,
        plan: fixture.plan,
        status: "active",
        fiveHour: reading(fixture, "five_hour"),
        weekly: reading(fixture, "seven_day"),
        usageCheckedAt: new Date(now - 2 * 60_000).toISOString(),
      }) as CodexAccount,
  );
  return codexAccountState(
    {
      accounts,
      pinnedAccountId: null,
      currentSelection: { credentialId: "o2", waiting: false },
      currentAccount: accounts[1]!,
      switchAppliedTo: null,
      loading: false,
      error: null,
      liveUsage: {},
      liveUsageUpdatedAt: null,
      pinning: false,
      pinningTarget: null,
      mutationError: null,
    },
    { checking: false, checked: false, failed: false },
  );
}

function HeaderStrip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      data-preview-control={label}
      className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2"
    >
      <span className="text-sm font-medium text-fg">{label}</span>
      <span className="text-xs text-fg-subtle">Session header</span>
      <span className="ml-auto">{children}</span>
    </div>
  );
}

function rowWindows(provider: string, fixture: Fixture, now: number) {
  const inputs: SubscriptionWindowInput[] = fixture.windows.map(([id, used, hours]) => ({
    id,
    usedPercent: used,
    resetsAt: iso(now, hours),
  }));
  return subscriptionWindows(provider, inputs, now);
}

function SettingsRows({
  provider,
  tile,
  fixtures,
  now,
}: {
  provider: string;
  tile: "codex" | "supergrok" | "claude_subscription";
  fixtures: Fixture[];
  now: number;
}) {
  return (
    <RowList label={`${provider} accounts`} columns={ACCOUNT_COLUMNS} flush>
      {fixtures.map((fixture) => (
        <SubscriptionAccountRow
          key={fixture.id}
          provider={tile}
          title={fixture.email}
          email={fixture.email}
          meta={["Everyone in Cloudgeni", subscriptionPlanLabel(provider, fixture.plan)]}
          cells={{
            usage: fixture.status ? null : (
              <SubscriptionUsageCell windows={rowWindows(provider, fixture, now)} now={now} />
            ),
          }}
          indicator={fixture.status ? { kind: "attention", label: "Needs reconnect" } : "open"}
          onOpen={() => {}}
        />
      ))}
    </RowList>
  );
}

export default function SubscriptionAccountsSection() {
  const now = Date.now();
  const ignore = () => {};
  return (
    <KitSection sectionKey="subscription-accounts">
      <KitBlock
        title="Use for next turn"
        description="The session-header account control. Open each one: full account names, the plan once when every account shares it, the next-turn mark, and every reported window."
      >
        <KitCanvas className="flex max-w-md flex-col gap-3">
          <HeaderStrip label="Claude">
            <SubscriptionAccountControl
              state={sharedState("claude", CLAUDE, "c2", now)}
              onChoose={ignore}
            />
          </HeaderStrip>
          <HeaderStrip label="ChatGPT">
            <SubscriptionAccountControl state={codexState(now)} onChoose={ignore} />
          </HeaderStrip>
          <HeaderStrip label="SuperGrok">
            <SubscriptionAccountControl
              state={sharedState("xai", GROK, "x1", now)}
              onChoose={ignore}
            />
          </HeaderStrip>
        </KitCanvas>
      </KitBlock>
      <KitBlock
        title="Models settings rows"
        description="The same windows and labels at the end of each account row."
      >
        <KitCanvas className="flex flex-col gap-6">
          <SettingsRows provider="claude" tile="claude_subscription" fixtures={CLAUDE} now={now} />
          <SettingsRows provider="codex" tile="codex" fixtures={CODEX} now={now} />
          <SettingsRows provider="xai" tile="supergrok" fixtures={GROK} now={now} />
        </KitCanvas>
      </KitBlock>
    </KitSection>
  );
}
