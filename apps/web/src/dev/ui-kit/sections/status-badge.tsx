import { CalendarClockIcon, KeyRoundIcon, StarIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { MetaChip, type MetaChipVariant } from "@/components/ui/meta-chip";
import {
  PRODUCT_STATUS_KEYS,
  PRODUCT_STATUSES,
  StatusBadge,
  StatusBadgeSkeleton,
  type ProductStatus,
  type StatusBadgeVariant,
} from "@/components/ui/status-badge";
import { SEMANTIC_TONE_META, SEMANTIC_TONES, type SemanticTone } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import {
  apiKeys,
  connectedCapabilities,
  personById,
  popularCapabilities,
  scheduleById,
} from "../fixtures";
import {
  Alternative,
  Fork,
  KitBlock,
  KitCanvas,
  KitSection,
  StateCell,
  StatesGrid,
  UsageNotes,
} from "../kit";
import { usePick } from "../picks";
import type { AlternativeId } from "./registry";

const BADGE_BY_PICK: Record<AlternativeId, StatusBadgeVariant> = {
  a: "dot",
  b: "outline",
  c: "tinted",
};

const CHIP_BY_PICK: Record<AlternativeId, MetaChipVariant> = {
  a: "text",
  b: "outline",
  c: "soft",
};

const TONE_NAMES: Record<SemanticTone, { name: string; token: string }> = {
  success: { name: "Green", token: "status-idle" },
  attention: { name: "Purple", token: "status-waiting" },
  progress: { name: "Amber", token: "status-running" },
  danger: { name: "Red", token: "danger" },
  neutral: { name: "Grey", token: "fg-subtle" },
};

/* Fixture rows, identical in every version. */
const gmail = connectedCapabilities.find((each) => each.id === "cap-gmail")!;
const linear = connectedCapabilities.find((each) => each.id === "cap-linear")!;
const github = popularCapabilities.find((each) => each.id === "cap-github")!;
const awsSchedule = scheduleById("sched-aws-cost");
const depsSchedule = scheduleById("sched-deps");
const expiredKey = apiKeys.find((each) => each.status === "expired")!;
const priya = personById("person-priya");

function Tile({ children, round = false }: { children: ReactNode; round?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-8 shrink-0 place-items-center border border-border bg-surface-2 text-xs font-semibold text-fg-muted [&>svg]:size-4",
        round ? "rounded-full" : "rounded-[10px]",
      )}
    >
      {children}
    </span>
  );
}

/**
 * A meta line. Chrome-less text chips (A) need a dot between them or they run
 * together into one phrase; pills (B, C) are separated by their own edges.
 */
function MetaLine({
  chip,
  className,
  children,
}: {
  chip: MetaChipVariant;
  className?: string;
  children: ReactNode[];
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-y-1",
        chip === "text" ? "gap-x-1.5" : "gap-x-2",
        className,
      )}
    >
      {children.map((child, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- static demo content, never reordered
        <Fragment key={index}>
          {chip === "text" && index > 0 ? (
            <span aria-hidden="true" className="text-xs leading-4.5 text-fg-subtle">
              ·
            </span>
          ) : null}
          {child}
        </Fragment>
      ))}
    </div>
  );
}

interface DemoRow {
  id: string;
  tile: ReactNode;
  round?: boolean;
  title: string;
  meta: ReactNode;
  status: ProductStatus;
  label?: string;
  reason?: string;
}

const ROWS: DemoRow[] = [
  {
    id: gmail.id,
    tile: gmail.monogram,
    title: gmail.name,
    meta: gmail.byLine,
    status: "connected",
  },
  {
    id: linear.id,
    tile: linear.monogram,
    title: linear.name,
    meta: linear.statusDetail ?? linear.byLine,
    status: "needs_reconnect",
  },
  {
    id: awsSchedule.id,
    tile: <CalendarClockIcon />,
    title: awsSchedule.name,
    meta: awsSchedule.cadenceShortLabel,
    status: "failed",
  },
  {
    id: depsSchedule.id,
    tile: <CalendarClockIcon />,
    title: depsSchedule.name,
    meta: depsSchedule.cadenceShortLabel,
    status: "paused",
  },
  {
    id: expiredKey.id,
    tile: <KeyRoundIcon />,
    title: expiredKey.name,
    meta: (
      <>
        <span className="font-mono">{expiredKey.prefixLabel}</span> · {expiredKey.accessLabel}
      </>
    ),
    status: "expired",
  },
  {
    id: priya.id,
    tile: priya.initials,
    round: true,
    title: priya.name,
    meta: priya.email ?? "",
    status: "invited",
  },
];

function PageHeaderDemo({ variant, chip }: { variant: StatusBadgeVariant; chip: MetaChipVariant }) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-[14px] border border-border bg-surface p-4">
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-[10px] border border-border bg-surface-2 text-sm font-semibold text-fg-muted"
      >
        {linear.monogram}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h4 className="min-w-0 truncate text-lg leading-[26px] font-semibold tracking-[-0.25px] text-fg">
            {linear.name}
          </h4>
          <StatusBadge status="needs_reconnect" variant={variant} />
        </div>
        <MetaLine chip={chip} className="mt-1">
          <span className="text-xs leading-4.5 text-fg-muted">{linear.byLine}</span>
          <MetaChip variant={chip}>Workspace</MetaChip>
        </MetaLine>
      </div>
    </div>
  );
}

function StatusRows({ variant }: { variant: StatusBadgeVariant }) {
  return (
    <ul className="flex min-w-0 flex-col divide-y divide-border">
      {ROWS.map((row) => (
        <li key={row.id} className="flex min-w-0 items-center gap-3 py-2.5">
          <Tile round={row.round}>{row.tile}</Tile>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm leading-5 font-medium text-fg">{row.title}</p>
            <p className="truncate text-xs leading-4.5 text-fg-subtle">{row.meta}</p>
          </div>
          <StatusBadge status={row.status} variant={variant} reason={row.reason}>
            {row.label}
          </StatusBadge>
        </li>
      ))}
    </ul>
  );
}

function AllStatuses({ variant }: { variant: StatusBadgeVariant }) {
  return (
    <div className={cn("flex min-w-0 flex-wrap gap-2", variant === "dot" && "gap-x-4")}>
      {PRODUCT_STATUS_KEYS.map((key) => (
        <StatusBadge key={key} status={key} variant={variant} />
      ))}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-xs font-medium text-fg-subtle">{children}</p>;
}

function VersionDemo({ id }: { id: AlternativeId }) {
  const variant = BADGE_BY_PICK[id];
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div>
        <Label>In a detail page header</Label>
        <PageHeaderDemo variant={variant} chip={CHIP_BY_PICK[id]} />
      </div>
      <div>
        <Label>In rows</Label>
        <StatusRows variant={variant} />
      </div>
      <div>
        <Label>Every status</Label>
        <AllStatuses variant={variant} />
      </div>
    </div>
  );
}

function ToneTable({ variant }: { variant: StatusBadgeVariant }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-[14px] border border-border bg-surface">
      <div className="hidden grid-cols-[112px_128px_minmax(0,1fr)] gap-4 border-b border-border px-4 py-2 text-xs font-medium text-fg-subtle @2xl/kit-section:grid">
        <span>Tone</span>
        <span>Means</span>
        <span>Statuses</span>
      </div>
      <ul className="divide-y divide-border">
        {SEMANTIC_TONES.map((tone) => {
          const statuses = PRODUCT_STATUS_KEYS.filter((key) => PRODUCT_STATUSES[key].tone === tone);
          return (
            <li
              key={tone}
              className="grid min-w-0 gap-x-4 gap-y-2 px-4 py-3 @2xl/kit-section:grid-cols-[112px_128px_minmax(0,1fr)] @2xl/kit-section:items-center"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn("size-2.5 shrink-0 rounded-full", SEMANTIC_TONE_META[tone].dot)}
                />
                <span className="text-sm font-medium text-fg">{TONE_NAMES[tone].name}</span>
                <code className="font-mono text-2xs text-fg-subtle @2xl/kit-section:hidden">
                  {TONE_NAMES[tone].token}
                </code>
              </span>
              <span className="flex min-w-0 flex-col text-sm text-fg-muted">
                {SEMANTIC_TONE_META[tone].meaning}
                <code className="hidden font-mono text-2xs text-fg-subtle @2xl/kit-section:block">
                  {TONE_NAMES[tone].token}
                </code>
              </span>
              <span className="flex min-w-0 flex-wrap gap-2">
                {statuses.map((key) => (
                  <StatusBadge key={key} status={key} variant={variant} />
                ))}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MetaChipTable() {
  const rows: Array<{ id: AlternativeId; name: string }> = [
    { id: "a", name: "Next to A" },
    { id: "b", name: "Next to B" },
    { id: "c", name: "Next to C" },
  ];
  return (
    <div className="grid min-w-0 gap-3 @2xl/kit-section:grid-cols-3">
      {rows.map((row) => (
        <KitCanvas key={row.id} canvas="surface" className="flex min-w-0 flex-col gap-3">
          <p className="text-xs font-medium text-fg-subtle">{row.name}</p>
          <MetaLine chip={CHIP_BY_PICK[row.id]}>
            <StatusBadge status="paused" variant={BADGE_BY_PICK[row.id]} />
            <MetaChip variant={CHIP_BY_PICK[row.id]}>ChatGPT Pro</MetaChip>
            <MetaChip variant={CHIP_BY_PICK[row.id]}>Organization</MetaChip>
            <MetaChip variant={CHIP_BY_PICK[row.id]}>Secret</MetaChip>
            <MetaChip variant={CHIP_BY_PICK[row.id]}>3 resets</MetaChip>
            <MetaChip variant={CHIP_BY_PICK[row.id]} icon={<StarIcon />}>
              Primary
            </MetaChip>
          </MetaLine>
        </KitCanvas>
      ))}
    </div>
  );
}

export default function StatusBadgeSection() {
  const pick = usePick("status-badge") ?? "b";
  const picked = BADGE_BY_PICK[pick];
  return (
    <KitSection sectionKey="status-badge">
      <Fork>
        <Alternative id="a">
          <VersionDemo id="a" />
        </Alternative>
        {/* One line, like A and C, so the three versions start at the same height. */}
        <Alternative id="b" rationale="A 22px bordered pill. The Capabilities chip.">
          <VersionDemo id="b" />
        </Alternative>
        <Alternative id="c">
          <VersionDemo id="c" />
        </Alternative>
      </Fork>

      <KitBlock
        title="The tone table"
        description="The real decision. Five tones, one meaning each, shared by every status in the product. Shown in your pick."
      >
        <ToneTable variant={picked} />
      </KitBlock>

      <StatesGrid description="The recommended bordered pill. Hover, focus or tap a badge with a reason.">
        <StateCell label="All tones" note="Always a dot and a word, never color alone.">
          <div className="flex flex-wrap justify-center gap-2">
            <StatusBadge status="connected" />
            <StatusBadge status="needs_reconnect" />
            <StatusBadge status="running" />
            <StatusBadge status="failed" />
            <StatusBadge status="paused" />
          </div>
        </StateCell>
        <StateCell label="With icon" note="For headers where the badge stands alone.">
          <div className="flex flex-wrap justify-center gap-2">
            <StatusBadge status="connected" icon="auto" />
            <StatusBadge status="needs_reconnect" icon="auto" />
            <StatusBadge status="syncing" icon="auto" />
            <StatusBadge status="expired" icon="auto" />
            <StatusBadge status="suspended" icon="auto" />
          </div>
        </StateCell>
        <StateCell label="Loading" note="Same footprint, so rows don't shift when it arrives.">
          <div className="flex flex-wrap items-center justify-center gap-4">
            <StatusBadgeSkeleton />
            <StatusBadgeSkeleton variant="dot" />
          </div>
        </StateCell>
        <StateCell
          label="Unavailable, with who can fix it"
          note="The reason is in a tooltip and read by screen readers."
        >
          <StatusBadge status="unavailable" reason={github.statusDetail} />
        </StateCell>
        <StateCell label="Failed, with what happens next" note="Says when it tries again.">
          <StatusBadge
            status="failed"
            reason="Couldn't read AWS Cost Explorer. It tries again Mon 28 Sep, 08:00."
          />
        </StateCell>
        <StateCell label="Off, with who can change it" note="Names who can turn it on.">
          <StatusBadge
            status="off"
            reason="Turned off for Acme Robotics. An organization admin can turn it on."
          />
        </StateCell>
        <StateCell
          label="Long text, truncated"
          note="The full label moves into the tooltip."
          align="stretch"
        >
          <div className="mx-auto flex w-40 min-w-0 flex-col items-start gap-2">
            <StatusBadge status="invited" reason={priya.statusLabel}>
              {priya.statusLabel}
            </StatusBadge>
            <StatusBadge
              status="invite_failed"
              reason="Invitation email failed. Check the address and resend."
            >
              Invitation email failed
            </StatusBadge>
          </div>
        </StateCell>
        <StateCell label="Live" note="Running and Syncing pulse. Still with reduced motion.">
          <div className="flex flex-wrap justify-center gap-2">
            <StatusBadge status="running" />
            <StatusBadge status="running" variant="dot" />
          </div>
        </StateCell>
        <StateCell
          label="Mobile 390"
          note="The badge wraps under the title before the title truncates."
          width="mobile"
          align="stretch"
          padding={false}
        >
          <div className="p-3">
            <PageHeaderDemo variant="outline" chip="outline" />
          </div>
        </StateCell>
      </StatesGrid>

      <KitBlock
        title="Metadata chips"
        description="Plans, scopes, types, counts and roles are not statuses: no dot, no color. Each chip look pairs with one badge look."
      >
        <MetaChipTable />
      </KitBlock>

      <UsageNotes
        use={[
          "The health or lifecycle of one thing: Connected, Running, Failed, Paused.",
          "A in rows next to the meta line, B in detail page and dialog headers, C only inside alerts.",
          "A reason whenever the status needs one: Unavailable, Off, Failed. Say why and who can fix it.",
          "One label per state everywhere. Add new statuses to the tone table, not at the call site.",
        ]}
        avoid={[
          "Plans, scopes, types, counts or roles such as ChatGPT Pro, Organization, Secret or Primary. Use a MetaChip.",
          "The normal state when it is the norm. People rows show a status only when it isn't Active.",
          "Actions or filters. Use a Button or a segmented control.",
          "Color alone, raw enums or title case: never NEEDS_RECONNECT or Needs Reconnect.",
        ]}
      />
    </KitSection>
  );
}
