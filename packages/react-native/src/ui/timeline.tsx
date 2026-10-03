import type {
  ActivityItem,
  AgentMessageItem,
  PendingApproval,
  PendingHumanInputRequest,
  TimelineGroup,
  TimelineItem,
  ToolCallItem,
} from "@opengeni/react/session";
import type { HumanInputAnswer } from "@opengeni/sdk";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  FadeIn,
  FadeInDown,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { ApprovalCard, QuestionCard } from "./cards";
import {
  activityItemsOf,
  formatDuration,
  itemTime,
  toolCallsOf,
  toolDetail,
  toolOutputPreview,
  toolTitle,
} from "./format";
import { AgentIcon, toolIconName } from "./icons";
import type { AgentTheme } from "./theme";

export type MarkdownRenderer = (text: string, theme: AgentTheme) => ReactNode;

export interface AgentTimelineProps {
  groups: readonly TimelineGroup[];
  theme: AgentTheme;
  running: boolean;
  approvals?: readonly PendingApproval[];
  humanInput?: readonly PendingHumanInputRequest[];
  onApproval?(approvalId: string, decision: "approve" | "reject"): void;
  onAnswer?(requestId: string, answers: HumanInputAnswer[] | null): void;
  /**
   * Where pending approvals and questions render. `tray`: the host renders
   * `AgentAttentionTray` above its composer and the timeline only marks the wait.
   */
  attentionPlacement?: "inline" | "tray";
  /** Open a full step view (e.g. `AgentStepsSheet`) instead of expanding work in place. */
  onOpenSteps?(steps: ActivityItem[], title: string): void;
  renderMarkdown?: MarkdownRenderer;
  /** Host display name for the agent. */
  agentName?: string;
  agentMark?: ReactNode;
  contentInsetTop?: number;
  contentInsetBottom?: number;
  emptyState?: ReactNode;
}

type Row =
  | { key: string; kind: "group"; group: TimelineGroup; live: boolean; failed: boolean }
  | { key: string; kind: "working" }
  | { key: string; kind: "approval"; approval: PendingApproval }
  | { key: string; kind: "question"; request: PendingHumanInputRequest };

const plainMarkdown: MarkdownRenderer = (text, theme) => (
  <Text style={{ color: theme.colors.text, fontSize: theme.type.body, lineHeight: theme.type.bodyLine }}>
    {text}
  </Text>
);

function groupTurnId(group: TimelineGroup): string | null {
  if (group.kind === "item") return "turnId" in group.item ? ((group.item as { turnId?: string | null }).turnId ?? null) : null;
  const first = activityItemsOf(group)[0] as { turnId?: string | null } | undefined;
  return first?.turnId ?? null;
}

/**
 * Within one turn, show the work summary before that turn's assistant prose: work happens
 * first and the answer reads as its conclusion (the projection lists prose first).
 */
export function orderWorkBeforeProse(groups: readonly TimelineGroup[]): TimelineGroup[] {
  const out = [...groups];
  for (let index = 1; index < out.length; index += 1) {
    const group = out[index]!;
    if (group.kind === "item") continue;
    const turnId = groupTurnId(group);
    if (!turnId) continue;
    let start = index;
    while (start > 0) {
      const previous = out[start - 1]!;
      if (previous.kind !== "item" || previous.item.kind !== "agent-message" || groupTurnId(previous) !== turnId) break;
      start -= 1;
    }
    if (start < index) {
      out.splice(index, 1);
      out.splice(start, 0, group);
    }
  }
  return out;
}

export function AgentTimeline(props: AgentTimelineProps) {
  const { theme, running } = props;
  const groups = useMemo(() => orderWorkBeforeProse(props.groups), [props.groups]);
  const rows = useMemo<Row[]>(() => {
    // The live turn is the newest turn in the log; its work block stays live while running.
    let liveTurnId: string | null = null;
    for (let index = groups.length - 1; index >= 0 && !liveTurnId; index -= 1) liveTurnId = groupTurnId(groups[index]!);
    const isLive = (group: TimelineGroup) => running && group.kind !== "item" && groupTurnId(group) === liveTurnId;
    const failedTurns = new Set(
      groups.flatMap((group) =>
        group.kind === "item" && group.item.kind === "turn-end" && group.item.outcome === "failed" && group.item.turnId
          ? [group.item.turnId]
          : [],
      ),
    );
    const out: Row[] = groups.map((group, index) => ({
      key: groupKey(group, index),
      kind: "group",
      group,
      live: isLive(group),
      failed: group.kind !== "item" && (group.outcome === "failed" || failedTurns.has(groupTurnId(group) ?? "")),
    }));
    const needsYou = (props.approvals?.length ?? 0) > 0 || (props.humanInput?.length ?? 0) > 0;
    if (running && !needsYou && !groups.some(isLive)) out.push({ key: "working", kind: "working" });
    if (props.attentionPlacement !== "tray") {
      for (const approval of props.approvals ?? []) out.push({ key: `approval:${approval.id}`, kind: "approval", approval });
      for (const request of props.humanInput ?? []) out.push({ key: `question:${request.id}`, kind: "question", request });
    }
    return out;
  }, [groups, running, props.approvals, props.humanInput, props.attentionPlacement]);

  return (
    <FlatList
      contentContainerStyle={{
        paddingTop: props.contentInsetTop ?? 12,
        paddingBottom: props.contentInsetBottom ?? 24,
        paddingHorizontal: theme.space.gutter,
        flexGrow: 1,
      }}
      data={rows}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      keyExtractor={(row) => row.key}
      ListEmptyComponent={props.emptyState ? <>{props.emptyState}</> : null}
      renderItem={({ item: row }) => (
        <Animated.View entering={FadeInDown.duration(220)} layout={LinearTransition.duration(180)}>
          <TimelineRow {...props} groups={groups} row={row} />
        </Animated.View>
      )}
      style={{ backgroundColor: theme.colors.background }}
    />
  );
}

function groupKey(group: TimelineGroup, index: number): string {
  if (group.kind === "item") {
    const item = group.item as TimelineItem & { reconciliationKey?: string };
    return item.reconciliationKey ?? item.id ?? `item:${index}`;
  }
  return `${group.kind}:${group.id}`;
}

function TimelineRow(props: AgentTimelineProps & { row: Row }) {
  const { row, theme } = props;
  if (row.kind === "working") return <WorkingLine theme={theme} label="Thinking" />;
  if (row.kind === "approval") {
    return <ApprovalCard approval={row.approval} theme={theme} onDecision={(decision) => props.onApproval?.(row.approval.id, decision)} />;
  }
  if (row.kind === "question") {
    return <QuestionCard request={row.request} theme={theme} onAnswer={(answers) => props.onAnswer?.(row.request.id, answers)} />;
  }
  const group = row.group;
  if (group.kind === "item") return <ItemRow item={group.item} {...props} />;
  const waiting = (props.approvals?.length ?? 0) > 0 || (props.humanInput?.length ?? 0) > 0;
  return <WorkBlock failed={row.failed} group={group} live={row.live} waiting={row.live && waiting} {...props} />;
}

function ItemRow(props: AgentTimelineProps & { item: TimelineItem }) {
  const { item, theme } = props;
  const render = props.renderMarkdown ?? plainMarkdown;
  switch (item.kind) {
    case "user-message":
      return <UserMessage text={item.text} theme={theme} />;
    case "agent-message":
      return <AssistantMessage item={item} render={render} theme={theme} />;
    case "turn-end":
      return item.outcome === "failed" && item.failureText ? (
        <Notice theme={theme} tone="danger" text={item.failureText} />
      ) : null;
    default:
      return null;
  }
}

export function UserMessage({ text, theme }: { text: string; theme: AgentTheme }) {
  return (
    <View style={{ alignItems: "flex-end", marginTop: theme.space.turn, marginBottom: theme.space.row }}>
      <View
        style={{
          maxWidth: "86%",
          backgroundColor: theme.colors.userBubble,
          borderRadius: theme.radius.bubble,
          paddingHorizontal: theme.type.body,
          paddingVertical: theme.type.body * 0.6,
        }}
      >
        <Text selectable style={{ color: theme.colors.onUserBubble, fontSize: theme.type.body, lineHeight: theme.type.bodyLine }}>
          {text}
        </Text>
      </View>
    </View>
  );
}

function AssistantMessage({ item, render, theme }: { item: AgentMessageItem; render: MarkdownRenderer; theme: AgentTheme }) {
  if (!item.text.trim()) return null;
  const commentary = item.phase === "commentary";
  return (
    <View style={{ marginVertical: theme.space.row, opacity: commentary ? 0.82 : 1 }}>{render(item.text, theme)}</View>
  );
}

function Notice({ theme, tone, text }: { theme: AgentTheme; tone: "danger" | "muted"; text: string }) {
  const danger = tone === "danger";
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 10,
        alignItems: "flex-start",
        marginVertical: theme.space.row,
        padding: 12,
        borderRadius: theme.radius.card,
        backgroundColor: danger ? theme.colors.dangerSurface : theme.colors.surface,
      }}
    >
      <AgentIcon color={danger ? theme.colors.danger : theme.colors.textMuted} name="alert" size={18} />
      <Text style={{ flex: 1, color: danger ? theme.colors.danger : theme.colors.textMuted, fontSize: theme.type.small, lineHeight: theme.type.smallLine }}>
        {text}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Agent work                                                                                  */
/* ------------------------------------------------------------------------------------------ */

function WorkBlock(
  props: AgentTimelineProps & { group: Exclude<TimelineGroup, { kind: "item" }>; live: boolean; waiting: boolean; failed: boolean },
) {
  const { group, theme, live, waiting, failed } = props;
  const items = activityItemsOf(group);
  const prose = group.kind === "activity" ? group.items.filter((item): item is AgentMessageItem => item.kind === "agent-message") : [];
  const steps = items.filter((item) => item.kind === "tool-call" || item.kind === "reasoning" || item.kind === "worker");
  const tools = toolCallsOf(items);
  const outcome = group.outcome;
  const failureText = group.failureText;
  const started = group.kind === "turn" ? Date.parse(group.startedAt) : itemTime(items[0] ?? {});
  const ended = group.kind === "turn" ? Date.parse(group.endedAt) : itemTime(items[items.length - 1] ?? {});
  const duration = formatDuration(ended - started);
  const running = live && !outcome;
  const current = running && !waiting ? [...tools].reverse().find((tool) => tool.status === "running") : undefined;
  const render = props.renderMarkdown ?? plainMarkdown;

  const work =
    steps.length === 0 ? null : theme.layout.activity === "rail" ? (
      <RailSteps items={steps} theme={theme} waiting={waiting} />
    ) : theme.layout.activity === "cards" ? (
      <CardSteps current={current} duration={duration} failed={failed} items={steps} onOpen={props.onOpenSteps} running={running} theme={theme} toolCount={tools.length} waiting={waiting} />
    ) : (
      <FoldSteps current={current} duration={duration} failed={failed} items={steps} onOpen={props.onOpenSteps} running={running} theme={theme} toolCount={tools.length} waiting={waiting} />
    );

  return (
    <View style={{ marginVertical: theme.space.row }}>
      {work}
      {prose.map((item) => (
        <View key={item.id} style={{ marginTop: theme.space.row }}>
          {render(item.text, theme)}
        </View>
      ))}
      {outcome === "failed" && failureText ? <Notice text={failureText} theme={theme} tone="danger" /> : null}
    </View>
  );
}

function stepLabel(item: ActivityItem): string {
  if (item.kind === "tool-call") return toolTitle(item);
  if (item.kind === "reasoning") return "Thought";
  if (item.kind === "worker") return "Worker";
  return "Step";
}

const LIVE_VERBS: Partial<Record<ReturnType<typeof toolIconName>, string>> = {
  terminal: "Running",
  search: "Searching",
  edit: "Editing",
  globe: "Browsing",
  rocket: "Deploying",
};

/** Present-tense description of a running tool ("Running bun test"). */
function liveLabel(tool: ToolCallItem): string {
  const verb = LIVE_VERBS[toolIconName(tool.name)];
  const detail = toolDetail(tool);
  if (!verb) return detail ? `${toolTitle(tool)} · ${detail}` : toolTitle(tool);
  return detail ? `${verb} ${detail}` : verb;
}

function StatusDot({ item, theme, size = 8, waiting }: { item: ActivityItem; theme: AgentTheme; size?: number; waiting?: boolean }) {
  const status = item.kind === "tool-call" ? item.status : "complete";
  const color =
    status === "failed"
      ? theme.colors.danger
      : status === "running"
        ? waiting
          ? theme.colors.attention
          : theme.colors.accent
        : theme.colors.textFaint;
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

/** Calm: one quiet line; tap to reveal the steps. */
type StepSummaryProps = {
  items: ActivityItem[];
  theme: AgentTheme;
  running: boolean;
  waiting: boolean;
  failed: boolean;
  duration: string;
  toolCount: number;
  current?: ToolCallItem;
  onOpen?(steps: ActivityItem[], title: string): void;
};

function FoldSteps(props: StepSummaryProps) {
  const { theme, running } = props;
  const [open, setOpen] = useState(false);
  const steps = props.toolCount ? `${props.toolCount} ${props.toolCount === 1 ? "step" : "steps"}` : "";
  const label = props.waiting
    ? "Waiting for you"
    : running
      ? props.current
      ? liveLabel(props.current)
      : "Working"
      : props.failed
        ? `Stopped${steps ? ` after ${steps}` : ""}`
        : [props.duration ? `Worked for ${props.duration}` : "Worked", steps].filter(Boolean).join(" · ");
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={8}
        onPress={() => (props.onOpen ? props.onOpen(props.items, label) : setOpen((value) => !value))}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32 }}
      >
        {props.waiting ? (
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.attention }} />
        ) : running ? (
          <Pulse theme={theme} />
        ) : null}
        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, color: props.waiting ? theme.colors.attention : theme.colors.textMuted, fontSize: theme.type.small + 1 }}
        >
          {label}
        </Text>
        <AgentIcon color={theme.colors.textFaint} name={open ? "chevron-down" : "chevron-right"} size={14} />
      </Pressable>
      {open ? (
        <Animated.View entering={FadeIn.duration(160)} style={{ marginTop: 4, marginLeft: 2, gap: 10, paddingVertical: 4 }}>
          {props.items.map((item) => (
            <CompactStep item={item} key={item.id} theme={theme} />
          ))}
        </Animated.View>
      ) : null}
    </View>
  );
}

function CompactStep({ item, theme }: { item: ActivityItem; theme: AgentTheme }) {
  const detail = item.kind === "tool-call" ? toolDetail(item) : item.kind === "reasoning" ? item.text : null;
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      <View style={{ paddingTop: 2 }}>
        <AgentIcon color={theme.colors.textFaint} name={item.kind === "tool-call" ? toolIconName(item.name) : "sparkle"} size={15} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.colors.text, fontSize: theme.type.small, lineHeight: theme.type.smallLine }}>{stepLabel(item)}</Text>
        {detail ? (
          <Text numberOfLines={2} style={{ color: theme.colors.textMuted, fontSize: theme.type.small, lineHeight: theme.type.smallLine }}>
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Workbench: always-visible rail with status dots, monospace input and output preview. */
export function AgentStepList(props: { items: readonly ActivityItem[]; theme: AgentTheme; waiting?: boolean }) {
  return <RailSteps items={props.items} theme={props.theme} waiting={props.waiting ?? false} />;
}

function RailSteps({ items, theme, waiting }: { items: readonly ActivityItem[]; theme: AgentTheme; waiting: boolean }) {
  return (
    <View style={{ paddingLeft: 4 }}>
      {items.map((item, index) => {
        const detail = item.kind === "tool-call" ? toolDetail(item) : null;
        const output = item.kind === "tool-call" && item.status !== "running" ? toolOutputPreview(item) : null;
        const reasoning = item.kind === "reasoning" ? item.text : null;
        const last = index === items.length - 1;
        return (
          <View key={item.id} style={{ flexDirection: "row", gap: 12 }}>
            <View style={{ alignItems: "center", width: 10 }}>
              <View style={{ height: 6 }} />
              <StatusDot item={item} theme={theme} waiting={waiting} />
              {last ? null : <View style={{ flex: 1, width: StyleSheet.hairlineWidth * 2, backgroundColor: theme.colors.rail, marginTop: 4 }} />}
            </View>
            <View style={{ flex: 1, paddingBottom: last ? 0 : 14 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <AgentIcon color={theme.colors.textMuted} name={item.kind === "tool-call" ? toolIconName(item.name) : "sparkle"} size={14} />
                <Text style={{ color: theme.colors.text, fontSize: theme.type.small + 1, fontWeight: "500" }}>{stepLabel(item)}</Text>
                {item.kind === "tool-call" && item.status === "running" ? (
                  waiting ? (
                    <Text style={{ color: theme.colors.attention, fontSize: theme.type.small, fontWeight: "600" }}>Waiting for you</Text>
                  ) : (
                    <Pulse theme={theme} />
                  )
                ) : null}
              </View>
              {detail ? (
                <Text numberOfLines={1} style={{ marginTop: 3, color: theme.colors.textMuted, fontFamily: theme.type.mono, fontSize: theme.type.small - 0.5 }}>
                  {detail}
                </Text>
              ) : null}
              {reasoning ? (
                <Text numberOfLines={3} style={{ marginTop: 3, color: theme.colors.textMuted, fontSize: theme.type.small, lineHeight: theme.type.smallLine, fontStyle: "italic" }}>
                  {reasoning}
                </Text>
              ) : null}
              {output ? (
                <View style={{ marginTop: 6, padding: 8, borderRadius: theme.radius.control, backgroundColor: theme.colors.codeBackground }}>
                  <Text numberOfLines={3} style={{ color: theme.colors.textMuted, fontFamily: theme.type.mono, fontSize: theme.type.small - 1, lineHeight: theme.type.smallLine - 1 }}>
                    {output}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** Field: one bold card stating what is happening now, steps on demand. */
function CardSteps(props: StepSummaryProps) {
  const { theme, running } = props;
  const [open, setOpen] = useState(false);
  const headline = props.waiting
    ? "Waiting for you"
    : running
    ? props.current
      ? (LIVE_VERBS[toolIconName(props.current.name)] ?? toolTitle(props.current))
      : "Working on it"
    : props.failed
      ? "Couldn't finish"
      : `Done · ${props.toolCount} ${props.toolCount === 1 ? "step" : "steps"}`;
  const sub = props.waiting
    ? "Answer below to continue"
    : running
      ? props.current
        ? toolDetail(props.current)
        : null
      : props.duration
        ? `Took ${props.duration}`
        : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={() => (props.onOpen ? props.onOpen(props.items, headline) : setOpen((value) => !value))}
      style={{
        borderRadius: theme.radius.card,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        padding: 16,
        minHeight: theme.layout.target,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: props.waiting
              ? theme.colors.attention
              : running
                ? theme.colors.accent
                : props.failed
                  ? theme.colors.dangerSurface
                  : theme.colors.background,
          }}
        >
          {props.waiting ? (
            <AgentIcon color={theme.colors.onAccent} name="alert" size={18} />
          ) : running ? (
            <Pulse color={theme.colors.onAccent} theme={theme} />
          ) : props.failed ? (
            <AgentIcon color={theme.colors.danger} name="x" size={18} strokeWidth={2.5} />
          ) : (
            <AgentIcon color={theme.colors.success} name="check" size={18} strokeWidth={2.5} />
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.colors.text, fontSize: theme.type.body, fontWeight: theme.type.weightStrong }}>{headline}</Text>
          {sub ? (
            <Text numberOfLines={1} style={{ color: theme.colors.textMuted, fontSize: theme.type.small, marginTop: 2 }}>
              {sub}
            </Text>
          ) : null}
        </View>
        <AgentIcon color={theme.colors.textFaint} name={open ? "chevron-down" : "chevron-right"} size={20} />
      </View>
      {open ? (
        <Animated.View entering={FadeIn.duration(160)} style={{ marginTop: 14, gap: 12 }}>
          {props.items.map((item) => (
            <CompactStep item={item} key={item.id} theme={theme} />
          ))}
        </Animated.View>
      ) : null}
    </Pressable>
  );
}

export function WorkingLine({ theme, label }: { theme: AgentTheme; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginVertical: theme.space.row, minHeight: 32 }}>
      <Pulse theme={theme} />
      <Text style={{ color: theme.colors.textMuted, fontSize: theme.type.small + 1 }}>{label}</Text>
    </View>
  );
}

function Pulse({ theme, color }: { theme: AgentTheme; color?: string }) {
  const opacity = useSharedValue(0.35);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(1, { duration: 700 }), -1, true);
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: color ?? theme.colors.accent }, style]} />;
}