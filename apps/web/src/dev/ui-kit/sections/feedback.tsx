import { CheckIcon, RotateCcwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { ErrorMessage } from "@/components/ui/error-message";
import { HelpLink, HelpTip, InlineHelp } from "@/components/ui/inline-help";
import { Notice } from "@/components/ui/notice";
import { StatGroup, StatTile } from "@/components/ui/stat-tile";
import { StatusBadge } from "@/components/ui/status-badge";
import { UsageMeter } from "@/components/ui/usage-meter";
import { cn } from "@/lib/utils";
import {
  codexWorkspaceAccounts,
  connectedCapabilities,
  currentWorkspace,
  knowledgeEntries,
  organization,
  scheduleById,
  variableSetById,
  variableSets,
} from "../fixtures";
import { KitBlock, KitCanvas, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";

const linear = connectedCapabilities.find((each) => each.id === "cap-linear")!;
const awsSchedule = scheduleById("sched-aws-cost");
const awsSet = variableSetById("vs-aws-production");
const ops = codexWorkspaceAccounts[0]!;
const REFERENCE = "4b1d7e2a-93c5-4f08-b6de-2a91c0f7e5d3";

/* ---------------------------------------------------------------- Which one */

/** How an action button reads in the examples column. An illustration, not a control. */
function ActionHint({ children }: { children: ReactNode }) {
  return (
    <span className="ml-1 inline-flex h-5 items-center rounded-md border border-border bg-surface px-1.5 align-middle text-2xs font-medium text-fg-muted">
      {children}
    </span>
  );
}

const WHICH: Array<{ name: string; when: string; example: ReactNode }> = [
  {
    name: "InlineHelp",
    when: "A static explanation that is always true.",
    example: `People come from ${organization.name}.`,
  },
  {
    name: "HelpTip",
    when: "A detail few people need, shown on demand.",
    example: "Where usage numbers come from.",
  },
  {
    name: "Notice",
    when: "A state that needs a word, with at most one action.",
    example: (
      <>
        {linear.name} needs reconnecting.
        <ActionHint>Reconnect {linear.name}</ActionHint>
      </>
    ),
  },
  {
    name: "ErrorMessage",
    when: "Something failed: what happened, then what to do.",
    example: "Couldn't load this connection's tools. Try again.",
  },
  {
    name: "DisabledReason",
    when: "A control that can't be used right now, and why.",
    example: "Only organization admins can invite people.",
  },
  {
    name: "Toast",
    when: "Confirms what the person just did. Undo when reversible.",
    example: (
      <>
        Archived.
        <ActionHint>Undo</ActionHint>
      </>
    ),
  },
  {
    name: "StatusBadge",
    when: "The ongoing state of one thing.",
    example: (
      <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
        <StatusBadge status="connected" variant="dot" />
        <StatusBadge status="needs_reconnect" variant="dot" />
        <StatusBadge status="failed" variant="dot" />
      </span>
    ),
  },
];

function WhichTable() {
  return (
    <div className="min-w-0 overflow-hidden rounded-[14px] border border-border bg-surface">
      <div className="hidden grid-cols-[136px_minmax(0,1fr)_minmax(0,1fr)] gap-4 border-b border-border px-4 py-2 text-xs font-medium text-fg-subtle @2xl/kit-section:grid">
        <span>Component</span>
        <span>Use when</span>
        <span>Example</span>
      </div>
      <ul className="divide-y divide-border">
        {WHICH.map((row) => (
          <li
            key={row.name}
            className="grid min-w-0 gap-x-4 gap-y-0.5 px-4 py-2.5 @2xl/kit-section:grid-cols-[136px_minmax(0,1fr)_minmax(0,1fr)]"
          >
            <span className="text-sm font-medium text-fg">{row.name}</span>
            <span className="text-sm text-fg-muted">{row.when}</span>
            <span className="text-xs leading-5 text-fg-muted">{row.example}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ Notice */

function NoticeGallery() {
  const [dismissed, setDismissed] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Notice tone="muted">
        Schedules run with the connected accounts of the person who created them.
      </Notice>
      <Notice tone="info" title="Takes effect from the next turn">
        Turns already running keep the current value.
      </Notice>
      <Notice
        tone="waiting"
        title={`${linear.name} needs reconnecting`}
        actionLayout="responsive"
        action={
          <Button size="sm" variant="outline" className="pointer-coarse:h-11">
            Reconnect {linear.name}
          </Button>
        }
      >
        {linear.statusDetail}
      </Notice>
      <Notice
        tone="failed"
        title={`${awsSchedule.name} failed`}
        actionLayout="responsive"
        action={
          <Button size="sm" variant="outline" className="pointer-coarse:h-11">
            View run
          </Button>
        }
      >
        {`Couldn't read AWS Cost Explorer. Check the ${awsSet.name} variable set.`}
      </Notice>
      <Notice tone="success" title="Copy your API key now">
        {"You won't be able to see it again after you close this dialog."}
      </Notice>
      {dismissed ? (
        <div className="flex items-center gap-2 text-xs text-fg-subtle">
          Dismissed.
          <HelpLink onClick={() => setDismissed(false)}>Show it again</HelpLink>
        </div>
      ) : (
        <Notice tone="muted" onDismiss={() => setDismissed(true)} dismissLabel="Dismiss this tip">
          {"Your Personal workspace is private. Organization admins can't see its chats."}
        </Notice>
      )}
    </div>
  );
}

function PausedBanner() {
  return (
    // The cell draws the frame; this only clips the banner to its inner corners.
    <div className="min-w-0 overflow-hidden rounded-[13px] bg-bg">
      <Notice
        layout="banner"
        tone="muted"
        actionLayout="responsive"
        className="bg-surface-2"
        action={
          <Button size="sm" variant="outline" className="pointer-coarse:h-11">
            Resume
          </Button>
        }
      >
        {`Agents in ${currentWorkspace.name} are paused. They resume in 52 minutes.`}
      </Notice>
      <div className="px-4 py-5">
        <p className="text-xl leading-7 font-semibold tracking-[-0.5px] text-fg">Schedules</p>
        <p className="mt-1 text-sm text-fg-muted">Recurring agent work in this workspace.</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Inline help */

function HelpDemo() {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div>
        <h4 className="text-sm font-semibold text-fg">Access</h4>
        <InlineHelp icon className="mt-1" action={<HelpLink href="#people">Go to People</HelpLink>}>
          {`People come from ${organization.name}. To add someone, invite them to the organization first.`}
        </InlineHelp>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-4 border-t border-border pt-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-fg">Usage</span>
            <HelpTip label="Where usage comes from">
              Codex reports usage for each account. OpenGeni checks it when you open this sheet.
            </HelpTip>
          </div>
          <p className="text-xs leading-4.5 text-fg-muted">{ops.checkedLabel}</p>
        </div>
        <UsageMeter label="Weekly" percent={22} variant="text" density="compact" />
      </div>
      <div className="border-t border-border pt-4">
        <InlineHelp>
          Facts go in the Library. Step-by-step procedures go in Skills (Capabilities).
        </InlineHelp>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Error message */

function RetryButton({ label = "Try again" }: { label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      className="pointer-coarse:h-11"
      // aria-disabled, not disabled, so keyboard focus stays on the button while it retries.
      aria-disabled={busy || undefined}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        setTimeout(() => setBusy(false), 1400);
      }}
    >
      <RotateCcwIcon aria-hidden="true" className={cn(busy && "motion-safe:animate-spin")} />
      {busy ? "Trying again…" : label}
    </Button>
  );
}

function CopyRewrite() {
  const rows = [
    {
      before: "OpenGeni API 404: Connected MCP connector not found Reference: 4b1d7e2a-93c5-…",
      after: "Couldn't load this connection's tools. Try again.",
    },
    {
      before: "Could not start setup. Retry setup",
      after: "Slack isn't set up on this OpenGeni server. Ask an admin.",
    },
    {
      before: "Request failed with status code 409",
      after: `${awsSet.name} is in use by ${awsSchedule.name}. Remove it there first.`,
    },
  ];
  return (
    <div className="min-w-0 overflow-hidden rounded-[14px] border border-border bg-surface">
      <div className="hidden grid-cols-2 gap-4 border-b border-border px-4 py-2 text-xs font-medium text-fg-subtle @2xl/kit-section:grid">
        <span className="pl-6">Today</span>
        <span className="pl-6">Instead</span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li
            key={row.after}
            className="grid min-w-0 gap-x-4 gap-y-1.5 px-4 py-3 @2xl/kit-section:grid-cols-2"
          >
            <span className="flex min-w-0 items-start gap-2">
              <XIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
              <span className="sr-only">Today: </span>
              <span className="min-w-0 font-mono text-xs leading-5 wrap-anywhere text-fg-subtle">
                {row.before}
              </span>
            </span>
            <span className="flex min-w-0 items-start gap-2">
              <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-idle" />
              <span className="sr-only">Instead: </span>
              <span className="min-w-0 text-sm leading-5 text-fg">{row.after}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------- Disabled reasons */

function DisabledDemo() {
  return (
    <div className="flex min-w-0 flex-col divide-y divide-border">
      <div className="flex min-w-0 items-center justify-between gap-4 pb-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">People</p>
          <p className="text-xs leading-4.5 text-fg-muted">Everyone in {organization.name}.</p>
        </div>
        <DisabledReason reason="Only organization admins can invite people. Ask Maria Chen or Bendik Hansen.">
          <Button size="sm" className="pointer-coarse:h-11">
            Invite people
          </Button>
        </DisabledReason>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">Usage limit reset</p>
          <p className="text-xs leading-4.5 text-fg-muted">{ops.resets[0]!.expiresLabel}</p>
        </div>
        <DisabledReason reason={`Only the person who connected ${ops.name} can redeem its resets.`}>
          <Button size="sm" variant="outline" className="pointer-coarse:h-11">
            Redeem
          </Button>
        </DisabledReason>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-4 pt-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">Bendik Hansen (You)</p>
          <p className="text-xs leading-4.5 text-fg-muted">Owner · bendik@acme.dev</p>
        </div>
        <DisabledReason reason="You're the only owner. Make someone else an owner first.">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Remove Bendik Hansen from the organization"
            className="pointer-coarse:size-11"
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        </DisabledReason>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Stat tiles */

const SESSIONS = [142, 168, 151, 174, 189, 96, 88, 163, 181, 177, 202, 214, 118, 107];
const TOKENS = [2.1, 2.8, 2.6, 3.1, 3.9, 1.4, 1.2, 3.3, 3.6, 3.4, 4.2, 4.6, 1.9, 1.7];
const SPEND = [18, 22, 21, 24, 29, 11, 9, 25, 27, 26, 31, 34, 14, 13];

function InsightsTiles() {
  return (
    <StatGroup label={`${currentWorkspace.name}, last 7 days`}>
      <StatTile
        label="Sessions"
        value="1,284"
        delta={{
          value: "+12%",
          trend: "up",
          sentiment: "positive",
          comparison: "vs previous 7 days",
        }}
        sparkline={SESSIONS}
      />
      <StatTile
        label="Tokens"
        value="48.2M"
        delta={{
          value: "+31%",
          trend: "up",
          sentiment: "neutral",
          comparison: "vs previous 7 days",
        }}
        sparkline={TOKENS}
      />
      <StatTile
        label="Spend"
        value="$312.40"
        delta={{
          value: "+8%",
          trend: "up",
          sentiment: "neutral",
          comparison: "vs previous 7 days",
        }}
        sparkline={SPEND}
      />
      <StatTile
        label="Failed runs"
        value="3"
        delta={{
          value: "-2",
          trend: "down",
          sentiment: "positive",
          comparison: "vs previous 7 days",
        }}
        sparkline={[5, 4, 6, 3, 5, 2, 4, 3, 2, 4, 3, 1, 2, 3]}
      />
    </StatGroup>
  );
}

/* ------------------------------------------------------------------- Toasts */

function ToastDemo() {
  const entry =
    knowledgeEntries.find((each) => each.id.includes("staging")) ?? knowledgeEntries[0]!;
  const deletable = variableSets.find((each) => each.usedBy.length === 0) ?? variableSets[0]!;
  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      <Button
        size="sm"
        variant="outline"
        className="pointer-coarse:h-11"
        onClick={() => toast.success("Maria Chen is now a Member")}
      >
        Change a role
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="pointer-coarse:h-11"
        onClick={() =>
          toast(`Archived "${entry.title}"`, {
            action: { label: "Undo", onClick: () => toast("Restored") },
          })
        }
      >
        Archive knowledge
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="pointer-coarse:h-11"
        onClick={() => toast.success(`Deleted ${deletable.name}`)}
      >
        Delete a variable set
      </Button>
    </div>
  );
}

function PolicyList({
  title,
  items,
  tone,
}: {
  title: string;
  items: ReactNode[];
  tone: "do" | "dont";
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-fg-subtle">{title}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {items.map((item, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- static copy, never reordered
          <li key={index} className="flex min-w-0 items-start gap-2 text-sm text-fg">
            {tone === "do" ? (
              <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-idle" />
            ) : (
              <XIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
            )}
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ----------------------------------------------------------------- Section */

export default function FeedbackSection() {
  return (
    <KitSection sectionKey="feedback">
      <KitBlock
        title="Which one"
        description="Pick by what the person needs to know and when. Most pages need only InlineHelp and, rarely, one Notice."
      >
        <WhichTable />
      </KitBlock>

      <KitBlock
        title="Notice"
        description="A quiet panel for a state that needs a word. Color marks the exception; muted is the default. The action sits in its slot on the right, never inside the text."
      >
        <KitCanvas>
          <NoticeGallery />
        </KitCanvas>
      </KitBlock>

      <StatesGrid title="Notice states" columns={2}>
        <StateCell label="Workspace banner" align="stretch" padding={false} span="full">
          <PausedBanner />
        </StateCell>
        <StateCell
          label="Long text"
          note="The action stays on the right while there's room."
          align="stretch"
        >
          <Notice
            tone="waiting"
            title="2 schedules use different learning settings"
            actionLayout="responsive"
            action={
              <Button size="sm" variant="outline" className="pointer-coarse:h-11">
                Review
              </Button>
            }
          >
            Weekly dependency update PR and Monthly access review publish knowledge without review,
            while chats in this workspace ask first.
          </Notice>
        </StateCell>
        <StateCell
          label="Mobile 390"
          note="The action moves under the text when the notice is narrow."
          width="mobile"
          align="stretch"
        >
          <Notice
            tone="waiting"
            title={`${linear.name} needs reconnecting`}
            actionLayout="responsive"
            action={
              <Button size="sm" variant="outline" className="pointer-coarse:h-11">
                Reconnect {linear.name}
              </Button>
            }
          >
            {linear.statusDetail}
          </Notice>
        </StateCell>
      </StatesGrid>

      <KitBlock
        title="Inline help"
        description="Static explanations become one muted 12px line. A HelpTip holds what only some people need."
      >
        <KitCanvas canvas="surface">
          <HelpDemo />
        </KitCanvas>
      </KitBlock>

      <KitBlock
        title="Error message"
        description="What happened, then what to do. The request reference moves into Technical details with Copy."
      >
        <div className="grid min-w-0 gap-4 @2xl/kit-section:grid-cols-2">
          <KitCanvas canvas="surface" className="flex flex-col gap-3">
            <p className="text-xs font-medium text-fg-subtle">Inline, inside a section</p>
            <ErrorMessage
              variant="inline"
              title="Couldn't load this connection's tools."
              action={<HelpLink onClick={() => undefined}>Try again</HelpLink>}
              reference={REFERENCE}
            />
          </KitCanvas>
          <KitCanvas canvas="surface" className="flex flex-col gap-3">
            <p className="text-xs font-medium text-fg-subtle">Block, in place of a section</p>
            <ErrorMessage
              title={`Couldn't load runs for ${awsSchedule.name}.`}
              action={<RetryButton />}
              reference={REFERENCE}
              details={[{ label: "Status", value: "503 Service unavailable" }]}
            >
              Check your connection and try again. Nothing was changed.
            </ErrorMessage>
          </KitCanvas>
        </div>
      </KitBlock>

      <StatesGrid title="Error states">
        <StateCell label="In place of a list" align="stretch" span={2}>
          <ErrorMessage
            align="center"
            title="Couldn't load variable sets."
            action={<RetryButton />}
            reference={REFERENCE}
          >
            Something went wrong on our side. Try again in a minute.
          </ErrorMessage>
        </StateCell>
        <StateCell label="Technical details open" align="stretch">
          <ErrorMessage
            variant="inline"
            title="Couldn't save the schedule."
            reference={REFERENCE}
            details={[{ label: "Status", value: "500 Internal error" }]}
            defaultDetailsOpen
          />
        </StateCell>
        <StateCell label="After an action" note="Announced to screen readers." align="stretch">
          <ErrorMessage
            variant="inline"
            announce
            title="Couldn't invite priya@acme.dev."
            action={<HelpLink onClick={() => undefined}>Resend</HelpLink>}
          >
            The invitation email bounced. Check the address.
          </ErrorMessage>
        </StateCell>
        <StateCell label="Long text" note="Says who can fix it." align="stretch">
          <ErrorMessage
            variant="inline"
            title={`Couldn't connect ${linear.name}.`}
            action={<HelpLink onClick={() => undefined}>Try again</HelpLink>}
          >
            Linear didn't accept the sign-in. If your organization restricts third-party apps, ask a
            Linear admin to approve OpenGeni.
          </ErrorMessage>
        </StateCell>
        <StateCell
          label="Mobile 390"
          note="Title and action only; the reference stays in Technical details."
          width="mobile"
          align="stretch"
        >
          <ErrorMessage
            title="Couldn't load this connection's tools."
            action={<RetryButton />}
            reference={REFERENCE}
          />
        </StateCell>
      </StatesGrid>

      <KitBlock
        title="Error copy"
        description="The same failures, in product words. The raw string only ever appears in Technical details."
      >
        <CopyRewrite />
      </KitBlock>

      <KitBlock
        title="Reasons for disabled controls"
        description="Hover, focus or tap a disabled control to see why. The control stays in the tab order and screen readers hear the reason. Native title tooltips are retired: they never show on touch or keyboard."
      >
        <KitCanvas canvas="surface">
          <DisabledDemo />
        </KitCanvas>
      </KitBlock>

      <KitBlock
        title="Stat tiles"
        description="One style for Insights, Billing and Machines: a 12px label, a tabular number, a delta against the previous period and an optional sparkline. Tiles share one frame with hairlines, never a card each."
      >
        <InsightsTiles />
      </KitBlock>

      <StatesGrid title="Stat tile states">
        <StateCell label="Billing, no delta" align="stretch" padding={false}>
          <StatGroup columns={2} label="Billing" className="m-4">
            <StatTile label="Credit balance" value="$1,240.00" caption={organization.name} />
            <StatTile label="Used this month" value="$312.40" caption="Since 1 Sep" />
          </StatGroup>
        </StateCell>
        <StateCell label="Machines, with a unit" align="stretch">
          <StatTile
            framed
            label="Memory"
            value="5.1"
            unit="of 16 GB"
            caption="Build box · Linux x86_64"
          />
        </StateCell>
        <StateCell label="Loading" align="stretch">
          <StatTile framed label="Sessions" loading />
        </StateCell>
        <StateCell label="No data yet" align="stretch">
          <StatTile framed label="Failed runs" empty="No runs yet" />
        </StateCell>
        <StateCell label="Bad news" align="stretch">
          <StatTile
            framed
            label="Failed runs"
            value="9"
            delta={{
              value: "+6",
              trend: "up",
              sentiment: "negative",
              comparison: "vs previous 7 days",
            }}
          />
        </StateCell>
        <StateCell label="Mobile 390" width="mobile" align="stretch" span="full">
          <InsightsTiles />
        </StateCell>
      </StatesGrid>

      <KitBlock
        title="Toasts"
        description="Toasts confirm what the person just did. Anything the system did on its own shows up where it happened, as a status or a Notice."
      >
        <div className="grid min-w-0 gap-6 @xl/kit-section:grid-cols-2">
          <PolicyList
            tone="do"
            title="Toast when"
            items={[
              "The person changed something and the page doesn't show it: Maria Chen is now a Member.",
              "The action is reversible. Offer Undo instead of a confirm dialog: Archived. Undo.",
              "Something saved away from view, like a row that left the list after Delete.",
            ]}
          />
          <PolicyList
            tone="dont"
            title="Don't toast"
            items={[
              "Background state changes. A machine that connects gets a Connected badge, not a toast on every visit.",
              "Errors the person needs to act on. Put an ErrorMessage where it failed.",
              "Validation. Show it on the field.",
              "Copy to clipboard. The copy button turns into a check.",
            ]}
          />
        </div>
        <div className="mt-5">
          <p className="mb-2 text-xs font-medium text-fg-subtle">Try them</p>
          <ToastDemo />
        </div>
      </KitBlock>

      <UsageNotes
        use={[
          "One message per problem, placed where it happened.",
          "Say what happened, then what to do, in product words.",
          "Name who can fix it when the person can't: an admin, the account owner.",
        ]}
        avoid={[
          "Buttons inside body text. Notices have an action slot.",
          "Stacked Notices. If a page needs two, one of them is InlineHelp.",
          "Raw API strings, status codes or references outside Technical details.",
          "Native title tooltips for anything that matters.",
        ]}
      />
    </KitSection>
  );
}
