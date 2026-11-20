import { formatSessionUsageMicros } from "@opengeni/sdk/session-usage-limits";
import type { AllowanceExhaustedRefusal } from "@opengeni/sdk";
import type { LearningRefusal } from "@opengeni/sdk/learning-refusal";
import { useOpenGeniText } from "@opengeni/react/messages";
import type { TimelineItem } from "@opengeni/react/session";
import {
  agentMemberSessionId,
  agentMemberText,
  agentMemberTitle,
  allowanceLabels,
  allowanceResetSentence,
  cleanMachineInputSummary,
  compactionPresentation,
  DEFAULT_SESSION_USAGE_LIMIT_LABELS,
  formatClockTime,
  goalLandmarkText,
  goalLandmarkTone,
  groupMachineInputMembers,
  isAgentMember,
  learningRefusalBody,
  learningRefusalTitle,
  MACHINE_INPUT_META,
  machineInputBatchLabel,
  machineInputSummaryIsUseful,
  readableMachineInputSource,
  workerCompletionPresentation,
  workerCompletionSections,
  type AgentTitleParts,
} from "@opengeni/react/timeline-model";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useNativeActivityOptions } from "./activity";
import { Icon, type NativeIconName } from "./icon";
import { withAlpha } from "./primitives";
import { fontStyle, useNativeTimelineTheme, type NativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   Conversation landmarks at phone width: goal pills, context compaction,
   other agents' updates, worker reports and the structured notices. The same
   words and choices as the web timeline (shared from
   @opengeni/react/timeline-model), drawn natively.
   -------------------------------------------------------------------------- */

type MachineInputBatchItem = Extract<TimelineItem, { kind: "machine-input-batch" }>;
type WorkerCompletionItem = Extract<TimelineItem, { kind: "worker-completion" }>;
type GoalItem = Extract<TimelineItem, { kind: "goal" }>;
type CompactionItem = Extract<TimelineItem, { kind: "context-compaction" }>;
type MachineInputMember = MachineInputBatchItem["members"][number];

type PillTone = "neutral" | "accent" | "success" | "waiting" | "failed";

function pillColors(theme: NativeTimelineTheme, tone: PillTone) {
  const c = theme.colors;
  const accent =
    tone === "accent"
      ? c.accent
      : tone === "success"
        ? c["status-idle"]
        : tone === "waiting"
          ? c["status-waiting"]
          : tone === "failed"
            ? c["status-failed"]
            : null;
  return accent
    ? { fg: accent, border: withAlpha(accent, 0.3), bg: withAlpha(accent, 0.1) }
    : { fg: c["fg-muted"], border: c.border, bg: c["surface-1"] };
}

/** A centred landmark pill: one line, or wrapping copy for a failure. */
function Pill({
  icon,
  tone,
  children,
  wraps = false,
  below,
}: {
  icon: NativeIconName;
  tone: PillTone;
  children: ReactNode;
  wraps?: boolean | undefined;
  below?: ReactNode;
}) {
  const theme = useNativeTimelineTheme();
  const colors = pillColors(theme, tone);
  return (
    <View
      accessibilityRole="text"
      style={{
        alignSelf: "center",
        maxWidth: "100%",
        alignItems: "center",
        gap: 2,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bg,
        borderRadius: wraps ? theme.radius.lg : 999,
        paddingHorizontal: 12,
        paddingVertical: wraps ? 6 : 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" }}>
        <Icon name={icon} size={14} color={colors.fg} />
        <Text
          numberOfLines={wraps ? undefined : 1}
          style={{
            ...fontStyle(theme),
            flexShrink: 1,
            fontSize: theme.size.sm,
            lineHeight: 18,
            color: colors.fg,
          }}
        >
          {children}
        </Text>
      </View>
      {below}
    </View>
  );
}

const GOAL_ICON: Record<GoalItem["action"], NativeIconName> = {
  set: "target",
  updated: "pencil",
  completed: "check",
  paused: "pause",
  resumed: "play",
  cleared: "trash-2",
  held: "circle-pause",
  continuation: "arrow-right",
};

/** A goal landmark: what happened to the goal, and the goal on one line. */
export function NativeGoalRow({ item }: { item: GoalItem }) {
  const t = useOpenGeniText();
  return (
    <Pill icon={GOAL_ICON[item.action]} tone={goalLandmarkTone(item.action)}>
      {goalLandmarkText(t, item)}
    </Pill>
  );
}

/**
 * Context compaction: compacting, compacted (with the sizes), rebuilt for a
 * new model, trimmed, or a failure with its recovery step and Details.
 */
export function NativeCompactionRow({ item }: { item: CompactionItem }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [open, setOpen] = useState(false);
  const { title, trigger, subtitle, details, failed, started, wraps } = compactionPresentation(
    t,
    item,
  );
  const tone: PillTone = failed ? "failed" : started ? "waiting" : "neutral";
  const colors = pillColors(theme, tone);
  return (
    <View style={{ alignItems: "center", gap: 6 }}>
      <Pill
        icon="shrink"
        tone={tone}
        wraps={wraps}
        below={
          subtitle || details ? (
            <View style={{ alignItems: "center", gap: 2 }}>
              {subtitle ? (
                <Text
                  numberOfLines={wraps ? undefined : 1}
                  style={{
                    ...fontStyle(theme),
                    textAlign: "center",
                    fontSize: theme.size.xs,
                    lineHeight: 16,
                    color: colors.fg,
                    opacity: 0.8,
                  }}
                >
                  {subtitle}
                </Text>
              ) : null}
              {details ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                  onPress={() => setOpen((value) => !value)}
                  hitSlop={10}
                  style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingVertical: 2 }}
                >
                  <Text
                    style={{ ...fontStyle(theme, 500), fontSize: theme.size.xs, color: colors.fg }}
                  >
                    {t("messageTimeline.details")}
                  </Text>
                  <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
                    <Icon name="chevron-down" size={12} color={colors.fg} />
                  </View>
                </Pressable>
              ) : null}
            </View>
          ) : null
        }
      >
        {trigger ? `${title} · ${trigger}` : title}
      </Pill>
      {details && open ? (
        <View
          style={{
            alignSelf: "stretch",
            gap: 6,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c["surface-1"],
            paddingHorizontal: 12,
            paddingVertical: 8,
          }}
        >
          {details.note ? <Small>{details.note}</Small> : null}
          {details.facts.map((fact) => (
            <View key={fact.label} style={{ flexDirection: "row", gap: 12 }}>
              <Small subtle>{fact.label}</Small>
              <Text
                selectable
                style={{
                  ...fontStyle(theme, 400, "mono"),
                  flex: 1,
                  fontSize: theme.size.xs,
                  lineHeight: 16,
                  color: c["fg-muted"],
                }}
              >
                {fact.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Small({ children, subtle = false }: { children: ReactNode; subtle?: boolean }) {
  const theme = useNativeTimelineTheme();
  return (
    <Text
      style={{
        ...fontStyle(theme),
        fontSize: theme.size.xs,
        lineHeight: 16,
        color: subtle ? theme.colors["fg-subtle"] : theme.colors["fg-muted"],
      }}
    >
      {children}
    </Text>
  );
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Updates that arrived while the agent worked: other agents' messages and
 * results, waits that ended, a generated video. A pill naming them that opens
 * the named rows, each linking to the agent's own chat.
 */
export function NativeMachineInputBatchRow({ item }: { item: MachineInputBatchItem }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [open, setOpen] = useState(false);
  const single = item.members.length === 1 ? item.members[0]! : null;
  if (single?.kind === "media_generation_result" && single.result)
    return <NativeVideoResultRow member={single} />;
  const label = machineInputBatchLabel(t, item.members);
  const singleSummary = single ? cleanMachineInputSummary(single.summary) : "";
  const showCollapsedSummary =
    !item.compact &&
    single != null &&
    !isAgentMember(single) &&
    machineInputSummaryIsUseful(t, single.kind, singleSummary);
  const colors = pillColors(theme, "neutral");
  return (
    <View style={{ alignItems: "center", gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityHint={t("messageTimeline.receivedClocktime", {
          clockTime: formatClockTime(t, item.occurredAt),
        })}
        onPress={() => setOpen((value) => !value)}
        hitSlop={6}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          maxWidth: "100%",
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.bg,
          borderRadius: 999,
          paddingHorizontal: 12,
          paddingVertical: 4,
        }}
      >
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon name="chevron-right" size={14} color={colors.fg} />
        </View>
        <Text
          numberOfLines={1}
          style={{ ...fontStyle(theme), flexShrink: 1, fontSize: theme.size.sm, color: colors.fg }}
        >
          {label}
        </Text>
      </Pressable>
      {open ? (
        <View
          style={{
            alignSelf: "stretch",
            gap: 4,
            borderTopWidth: 1,
            borderTopColor: withAlpha(c.border, 0.5),
            paddingTop: 8,
          }}
        >
          <Small subtle>
            {t("messageTimeline.receivedClocktime", {
              clockTime: formatClockTime(t, item.occurredAt).replace(" at ", ", "),
            })}
          </Small>
          {groupMachineInputMembers(item.members).map((group) =>
            group.kind === "agent" ? (
              <AgentMemberRow key={group.members[0]!.id} members={group.members} />
            ) : (
              <MachineInputRow key={group.member.id} member={group.member} />
            ),
          )}
        </View>
      ) : null}
      {showCollapsedSummary ? (
        <Text
          style={{
            ...fontStyle(theme),
            textAlign: "center",
            paddingHorizontal: 12,
            fontSize: theme.size.xs,
            lineHeight: 16,
            color: c["fg-subtle"],
          }}
        >
          {shorten(singleSummary, 160)}
        </Text>
      ) : null}
    </View>
  );
}

function agentMemberIcon(member: MachineInputMember): NativeIconName {
  if (member.kind === "child_terminal_result" && member.classification === "failure")
    return "circle-x";
  if (member.kind === "child_paused") return "circle-pause";
  return "corner-down-right";
}

function AgentMemberRow({ members }: { members: MachineInputMember[] }) {
  const t = useOpenGeniText();
  const latest = members[members.length - 1]!;
  const texts = members.map((member) => agentMemberText(t, member));
  const latestText = texts[texts.length - 1]!;
  const bodies = texts
    .map((text, index) => ({ id: members[index]!.id, body: text.body }))
    .filter((entry) => entry.body.length > 0);
  return (
    <NativeAgentRow
      icon={agentMemberIcon(latest)}
      title={agentMemberTitle(t, latest, null)}
      preview={latestText.preview ? shorten(latestText.preview, 320) : null}
      meta={
        members.length > 1
          ? t("native.timeline.landmarks.earlier", { count: members.length - 1 })
          : null
      }
      sessionId={agentMemberSessionId(latest)}
      failed={latest.kind === "child_terminal_result" && latest.classification === "failure"}
      sections={bodies.map((entry) => ({ id: entry.id, value: entry.body }))}
    />
  );
}

function MachineInputRow({ member }: { member: MachineInputMember }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  if (member.kind === "media_generation_result" && member.result)
    return <NativeVideoResultRow member={member} />;
  const source = readableMachineInputSource(member.sourceId);
  const summary =
    member.kind === "scheduled_occurrence" ? "" : cleanMachineInputSummary(member.summary);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 4 }}>
      <View
        style={{
          marginTop: 7,
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: c["fg-subtle"],
        }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ ...fontStyle(theme, 500), fontSize: theme.size.sm, color: c["fg-muted"] }}>
          {MACHINE_INPUT_META(t)[member.kind]}
          {source ? (
            <Text style={{ ...fontStyle(theme), color: c["fg-subtle"] }}>
              {`  ${t("messageTimeline.fromSource", { source })}`}
            </Text>
          ) : null}
        </Text>
        {summary ? (
          <Text
            selectable
            style={{
              ...fontStyle(theme),
              marginTop: 2,
              fontSize: theme.size.sm,
              lineHeight: 20,
              color: c.fg,
            }}
          >
            {shorten(summary, 320)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** A generated video: ready (its size and length) or failed with the reason. */
function NativeVideoResultRow({ member }: { member: MachineInputMember }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const result = member.result!;
  const failed = result.status !== "ready";
  const facts =
    result.status === "ready"
      ? `${result.receipt.video.width}×${result.receipt.video.height} · ${
          Math.round(result.receipt.video.durationSeconds * 10) / 10
        }s${result.receipt.video.hasAudio ? " · Audio" : ""}`
      : result.boundedPublicReason;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: failed ? withAlpha(c["status-failed"], 0.3) : c.border,
        backgroundColor: failed ? withAlpha(c["status-failed"], 0.05) : c["surface-1"],
        paddingHorizontal: 14,
        paddingVertical: 10,
      }}
    >
      <Icon
        name={failed ? "circle-x" : "video"}
        size={16}
        color={failed ? c["status-failed"] : c["fg-muted"]}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{
            ...fontStyle(theme, 500),
            fontSize: theme.size.sm,
            color: failed ? c["status-failed"] : c.fg,
          }}
        >
          {failed
            ? t("messageTimeline.videoGenerationFailed")
            : t("messageTimeline.generatedVideo")}
        </Text>
        <Text style={{ ...fontStyle(theme), fontSize: theme.size.xs, color: c["fg-muted"] }}>
          {facts}
        </Text>
      </View>
    </View>
  );
}

/** A worker reporting back: outcome and goal on the row, the report behind it. */
export function NativeWorkerCompletionRow({ item }: { item: WorkerCompletionItem }) {
  const t = useOpenGeniText();
  const { title, outcome } = workerCompletionPresentation(t, item, null);
  return (
    <NativeAgentRow
      icon={
        outcome === "failed"
          ? "circle-x"
          : outcome === "paused"
            ? "circle-pause"
            : outcome === "completed"
              ? "circle-check"
              : "bot"
      }
      title={title}
      preview={item.goalText ? shorten(item.goalText, 240) : null}
      sessionId={item.childSessionId}
      failed={outcome === "failed"}
      sections={workerCompletionSections(t, item).map((section) => ({
        id: section.label,
        label: section.label,
        value: section.value,
        muted: section.muted === true,
      }))}
    />
  );
}

/**
 * One row for an update from another agent: names it, previews what it said,
 * opens the full text in place, and links to the agent's own chat.
 */
function NativeAgentRow({
  icon,
  title,
  preview,
  meta,
  sessionId,
  failed,
  sections,
}: {
  icon: NativeIconName;
  title: AgentTitleParts;
  preview: string | null;
  meta?: string | null | undefined;
  sessionId: string | null;
  failed: boolean;
  sections: { id: string; label?: string; value: string; muted?: boolean }[];
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const { onOpenSession } = useNativeActivityOptions();
  const [open, setOpen] = useState(false);
  const hasBody = sections.length > 0;
  const titleColor = failed ? c["status-failed"] : c.fg;
  const row = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        minHeight: 44,
        paddingHorizontal: 6,
        paddingVertical: 10,
      }}
    >
      <View style={{ marginTop: 3, width: 14, transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
        {hasBody ? <Icon name="chevron-right" size={14} color={c["fg-subtle"]} /> : null}
      </View>
      <View style={{ marginTop: 3 }}>
        <Icon name={icon} size={14} color={failed ? c["status-failed"] : c["fg-subtle"]} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{ ...fontStyle(theme), fontSize: theme.size.base, lineHeight: 20, color: c.fg }}
        >
          {title.name ? (
            <>
              {title.before ? <Text style={{ color: c["fg-muted"] }}>{title.before}</Text> : null}
              <Text style={{ ...fontStyle(theme, 500), color: titleColor }}>{title.name}</Text>
              {title.after ? <Text style={{ color: c["fg-muted"] }}>{title.after}</Text> : null}
            </>
          ) : (
            <Text style={{ ...fontStyle(theme, 500), color: titleColor }}>{title.text}</Text>
          )}
          {meta ? (
            <Text style={{ fontSize: theme.size.xs, color: c["fg-subtle"] }}>{`  ${meta}`}</Text>
          ) : null}
        </Text>
        {preview && !open ? (
          <Text
            numberOfLines={2}
            style={{
              ...fontStyle(theme),
              marginTop: 2,
              fontSize: theme.size.sm,
              lineHeight: 20,
              color: c["fg-muted"],
            }}
          >
            {preview}
          </Text>
        ) : null}
      </View>
      {failed ? (
        <Text
          style={{
            ...fontStyle(theme, 400, "mono"),
            alignSelf: "center",
            fontSize: theme.size.xs,
            color: c["status-failed"],
          }}
        >
          {t("timeline.agentRow.failed")}
        </Text>
      ) : null}
      {sessionId && onOpenSession ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            title.name
              ? t("timeline.agentRow.openName", { name: title.name })
              : t("timeline.agentRow.openAgentSession")
          }
          onPress={() => onOpenSession(sessionId)}
          hitSlop={8}
          style={{
            width: 36,
            height: 36,
            marginVertical: -8,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="arrow-up-right" size={15} color={c["fg-subtle"]} />
        </Pressable>
      ) : null}
    </View>
  );
  return (
    <View>
      {hasBody ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((value) => !value)}
        >
          {row}
        </Pressable>
      ) : (
        row
      )}
      {open ? (
        <View
          style={{
            marginLeft: 34,
            marginRight: 6,
            marginBottom: 8,
            gap: 8,
            borderLeftWidth: 1,
            borderLeftColor: c.border,
            paddingLeft: 14,
          }}
        >
          {sections.map((section) => (
            <View key={section.id} style={{ gap: 2 }}>
              {section.label ? <Small subtle>{section.label}</Small> : null}
              <Text
                selectable
                style={{
                  ...fontStyle(theme),
                  fontSize: theme.size.sm,
                  lineHeight: 22,
                  color: section.muted ? c["fg-muted"] : c.fg,
                }}
              >
                {section.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/* --------------------------------------------------------------- notices -- */

function CalmNotice({
  icon,
  title,
  body,
}: {
  icon: NativeIconName;
  title: string;
  body?: string | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View
      accessibilityRole="text"
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: withAlpha(c["status-waiting"], 0.35),
        backgroundColor: withAlpha(c["status-waiting"], 0.08),
        paddingHorizontal: 14,
        paddingVertical: 10,
      }}
    >
      <View style={{ marginTop: 2 }}>
        <Icon name={icon} size={16} color={c["status-waiting"]} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ ...fontStyle(theme, 500), fontSize: 14, lineHeight: 20, color: c.fg }}>
          {title}
        </Text>
        {body ? (
          <Text style={{ ...fontStyle(theme), fontSize: 14, lineHeight: 20, color: c["fg-muted"] }}>
            {body}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** A usage ceiling stopped further work: who can raise it, and when it resets. */
export function NativeAllowanceExhaustedRow({ refusal }: { refusal: AllowanceExhaustedRefusal }) {
  const t = useOpenGeniText();
  const labels = allowanceLabels(t, undefined);
  const workspace = refusal.scope === "workspace";
  return (
    <CalmNotice
      icon="gauge"
      title={workspace ? labels.workspaceLimitReachedTitle : labels.memberLimitReachedTitle}
      body={`${workspace ? labels.workspaceRemedy : labels.memberRemedy} ${allowanceResetSentence(
        labels,
        refusal.resetsAt,
      )}`}
    />
  );
}

/** The task's usage limit stopped further model requests here, with the amounts. */
export function NativeSessionUsageLimitRow({
  stop,
}: {
  stop: { usedMicros: number | null; limitMicros: number | null };
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const labels = DEFAULT_SESSION_USAGE_LIMIT_LABELS(t);
  const amount =
    stop.usedMicros !== null && stop.limitMicros !== null
      ? labels.usedOfLimit(
          formatSessionUsageMicros(stop.usedMicros),
          formatSessionUsageMicros(stop.limitMicros),
        )
      : null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="gauge" size={14} color={c["status-waiting"]} />
      <Text style={{ ...fontStyle(theme), flex: 1, fontSize: theme.size.sm, color: c["fg-muted"] }}>
        <Text style={{ ...fontStyle(theme, 500), color: c.fg }}>{labels.reachedTitle}</Text>
        {amount ? ` · ${amount}` : ""}
      </Text>
    </View>
  );
}

/** A change the agent tried to save to Skills, instructions or Knowledge was refused. */
export function NativeLearningRefusalRow({ refusal }: { refusal: LearningRefusal }) {
  const t = useOpenGeniText();
  return (
    <CalmNotice
      icon="brain-circuit"
      title={learningRefusalTitle(t, refusal)}
      body={learningRefusalBody(t, refusal)}
    />
  );
}
