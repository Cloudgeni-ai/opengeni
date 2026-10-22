import type { ClientModel, LineageNode, SessionBackgroundCommand } from "@opengeni/sdk";
import type { UseGoalResult } from "@opengeni/react/session";
import {
  sessionAgentAttention,
  sessionAgentsSignal,
  sessionGoalStateLabel,
} from "@opengeni/react/session-agents-model";
import { useOpenGeniText } from "@opengeni/react/messages";
import { createContext, useContext, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View, type TextStyle } from "react-native";
import { Button } from "./controls";
import { Icon, type NativeIconName } from "./icon";
import { SessionRow } from "./session-list";
import { BottomSheet } from "./sheet";
import { fontStyle, useNativeTimelineTheme, type NativeTimelineTheme } from "./theme";
import { useNativeTimelineMessages } from "./messages";

/** True where the signals share their row (beside the queue): icon chips only. */
export const CompactSignalsContext = createContext(false);

/* ----------------------------------------------------------------------------
   The web session chrome's goal, agents and commands segments: one row of
   quiet chips above the composer, each opening its panel as a sheet. A chip
   appears only when there is something to show.
   -------------------------------------------------------------------------- */

export interface SessionCommandsSource {
  commands: SessionBackgroundCommand[];
  loading: boolean;
  error: Error | null;
  cancel: (commandId: string) => Promise<void>;
}

export function SessionSignals(props: {
  goal?: UseGoalResult | null | undefined;
  agents: readonly LineageNode[];
  commandsCount: number;
  /** Mounted only while the commands sheet is open, so a closed chip never polls. */
  renderCommands: (close: () => void) => ReactNode;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  models?: readonly ClientModel[] | undefined;
  readOnly?: boolean | undefined;
}) {
  const m = useNativeTimelineMessages();
  const t = useOpenGeniText();
  // Beside the queue the row is shared: chips keep only their icon, count and dot.
  const compact = useContext(CompactSignalsContext);
  const [open, setOpen] = useState<"goal" | "agents" | "commands" | null>(null);
  const goal = props.goal?.goal ?? null;
  const agents = sessionAgentsSignal(t, props.agents);
  if (!goal && !agents && props.commandsCount === 0) return null;
  const close = () => setOpen(null);
  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 6, alignItems: "center" }}
        style={{ flexGrow: 0, flexShrink: 1 }}
      >
        {goal ? (
          <Chip
            icon="target"
            label={m.goal}
            detail={sessionGoalStateLabel(t, goal)}
            tone={goal.status === "active" ? "running" : "neutral"}
            compact={compact}
            onPress={() => setOpen("goal")}
          />
        ) : null}
        {agents ? (
          <Chip
            icon="bot"
            label={t("counts.agents", { count: agents.count })}
            count={agents.count}
            detail={agents.detail}
            tone={agents.tone}
            compact={compact}
            onPress={() => setOpen("agents")}
          />
        ) : null}
        {props.commandsCount > 0 ? (
          <Chip
            icon="terminal"
            label={t("counts.commands", { count: props.commandsCount })}
            count={props.commandsCount}
            detail={m.running}
            tone="running"
            compact={compact}
            onPress={() => setOpen("commands")}
          />
        ) : null}
      </ScrollView>

      <BottomSheet open={open === "goal"} onClose={close} accessibilityLabel={m.goal}>
        {goal && props.goal ? <GoalPanel goal={props.goal} readOnly={props.readOnly} /> : null}
      </BottomSheet>
      <BottomSheet open={open === "agents"} onClose={close} accessibilityLabel={m.agents}>
        <SheetTitle>{m.agents}</SheetTitle>
        <ScrollView style={{ paddingHorizontal: 12 }}>
          {/* Newest first, as the server lists them and the sidebar orders chats. */}
          {props.agents.map((node) => (
            <AgentNode
              key={node.session.id}
              node={node}
              models={props.models ?? []}
              onOpen={(sessionId) => {
                close();
                props.onOpenSession?.(sessionId);
              }}
            />
          ))}
        </ScrollView>
      </BottomSheet>
      <BottomSheet open={open === "commands"} onClose={close} accessibilityLabel={m.commands}>
        <SheetTitle>{m.commands}</SheetTitle>
        {open === "commands" ? props.renderCommands(close) : null}
      </BottomSheet>
    </>
  );
}

function Chip(props: {
  icon: NativeIconName;
  label: string;
  count?: number | undefined;
  detail: string;
  tone: "running" | "waiting" | "neutral";
  compact?: boolean | undefined;
  onPress: () => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const toneColor =
    props.tone === "running"
      ? c["status-running"]
      : props.tone === "waiting"
        ? c["status-waiting"]
        : c["fg-subtle"];
  // Compact on the phone: the status reads from the dot (and the sheet); the
  // word stays in the accessibility label. 30pt tall, 44pt to touch.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${props.detail}`}
      onPress={props.onPress}
      hitSlop={{ top: 7, bottom: 7, left: 3, right: 3 }}
      style={({ pressed }) => [
        signalChipStyle(theme, pressed),
        props.compact ? { paddingHorizontal: 9, gap: 4 } : null,
      ]}
    >
      <Icon name={props.icon} size={13} color={c["fg-muted"]} />
      {props.compact ? (
        props.count !== undefined ? (
          <Text style={signalChipText(theme)}>{props.count}</Text>
        ) : null
      ) : (
        <Text style={signalChipText(theme)}>{props.label}</Text>
      )}
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor }} />
    </Pressable>
  );
}

/**
 * One sub-agent, as the web agents panel lists it: its status, title, model and
 * last update, or the word to act on (Needs you · 10h, Failed, Stuck, Paused).
 * Its own agents fold under it behind a count, one level deep like the web.
 */
function AgentNode(props: {
  node: LineageNode;
  models: readonly ClientModel[];
  onOpen: (sessionId: string) => void;
  nested?: boolean | undefined;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [expanded, setExpanded] = useState(false);
  const { session, children } = props.node;
  const paused = session.status !== "cancelled" && session.effectiveControl.state !== "active";
  const attention = sessionAgentAttention(t, session, paused);
  const count = children.length;
  return (
    <View style={props.nested ? { paddingLeft: 18 } : undefined}>
      <SessionRow
        session={session}
        models={props.models}
        attention={attention}
        onPress={() => props.onOpen(session.id)}
      />
      {count > 0 && !props.nested ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={t("counts.agents", { count })}
            onPress={() => setExpanded((value) => !value)}
            hitSlop={{ top: 6, bottom: 6 }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              alignSelf: "flex-start",
              marginLeft: 24,
              marginBottom: 6,
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: theme.radius.md,
              backgroundColor: pressed ? c.hover : "transparent",
            })}
          >
            <Icon
              name={expanded ? "chevron-down" : "chevron-right"}
              size={12}
              color={c["fg-subtle"]}
            />
            <Text style={{ ...fontStyle(theme, 500), fontSize: 12, color: c["fg-muted"] }}>
              {t("counts.agents", { count })}
            </Text>
          </Pressable>
          {expanded
            ? children.map((child) => (
                <AgentNode
                  key={child.session.id}
                  node={child}
                  models={props.models}
                  onOpen={props.onOpen}
                  nested
                />
              ))
            : null}
        </>
      ) : null}
    </View>
  );
}

function SheetTitle({ children }: { children: string }) {
  const theme = useNativeTimelineTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{
        ...fontStyle(theme, 600),
        fontSize: 17,
        color: theme.colors.fg,
        paddingHorizontal: 20,
        paddingBottom: 8,
      }}
    >
      {children}
    </Text>
  );
}

function GoalPanel({ goal, readOnly }: { goal: UseGoalResult; readOnly?: boolean | undefined }) {
  const theme = useNativeTimelineTheme();
  const m = useNativeTimelineMessages();
  const t = useOpenGeniText();
  const c = theme.colors;
  const record = goal.goal!;
  const body = { ...fontStyle(theme, 400), fontSize: 15, lineHeight: 22, color: c.fg };
  const label = { ...fontStyle(theme, 600), fontSize: 12, color: c["fg-subtle"] };
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12, gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ ...fontStyle(theme, 600), fontSize: 17, color: c.fg }}>{m.goal}</Text>
        <Text style={{ ...fontStyle(theme, 500), fontSize: 13, color: c["fg-muted"] }}>
          {sessionGoalStateLabel(t, record)}
        </Text>
      </View>
      <View style={{ gap: 4 }}>
        <Text style={label}>{t("native.timeline.sessionSignals.objective")}</Text>
        <Text style={body} selectable>
          {record.text}
        </Text>
      </View>
      {record.successCriteria ? (
        <View style={{ gap: 4 }}>
          <Text style={label}>{t("native.timeline.sessionSignals.doneWhen")}</Text>
          <Text style={body} selectable>
            {record.successCriteria}
          </Text>
        </View>
      ) : null}
      {record.status === "paused" && record.rationale ? (
        <View style={{ gap: 4 }}>
          <Text style={label}>{t("native.timeline.sessionSignals.whyItPaused")}</Text>
          <Text style={body}>{record.rationale}</Text>
        </View>
      ) : null}
      {record.status === "completed" && record.evidence ? (
        <View style={{ gap: 4 }}>
          <Text style={label}>{t("native.timeline.sessionSignals.evidence")}</Text>
          <Text style={body}>{record.evidence}</Text>
        </View>
      ) : null}
      {!readOnly && record.status !== "completed" ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {record.status === "active" ? (
            <Button
              label={m.pauseGoal}
              icon="pause"
              busy={goal.updating}
              onPress={() => void goal.pause()}
            />
          ) : (
            <Button
              label={m.resumeGoal}
              icon="play"
              variant="primary"
              busy={goal.updating}
              onPress={() => void goal.resume()}
            />
          )}
        </View>
      ) : null}
      {goal.mutationError ? (
        <Text style={{ ...body, color: c["status-failed"] }}>{goal.mutationError.message}</Text>
      ) : null}
    </ScrollView>
  );
}

/** The web commands panel: each running command with its state and a Stop action. */
export function SessionCommandsList({
  commands,
  readOnly,
}: {
  commands: SessionCommandsSource;
  readOnly?: boolean | undefined;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const m = useNativeTimelineMessages();
  const c = theme.colors;
  if (commands.loading && commands.commands.length === 0) {
    return <ActivityIndicator style={{ padding: 24 }} />;
  }
  if (commands.commands.length === 0) {
    return (
      <Text style={{ ...fontStyle(theme, 400), color: c["fg-muted"], padding: 20 }}>
        {t("native.timeline.sessionSignals.noCommandsAreRunning")}
      </Text>
    );
  }
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, gap: 8, paddingBottom: 12 }}>
      {commands.commands.map((command) => {
        const running = command.state === "running";
        return (
          <View
            key={command.id}
            style={{
              gap: 6,
              padding: 12,
              borderRadius: theme.radius.md,
              backgroundColor: c["surface-2"],
            }}
          >
            <Text
              numberOfLines={3}
              style={{ ...fontStyle(theme, 400, "mono"), fontSize: 13, color: c.fg }}
            >
              {`$ ${command.commandPreview}`}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text
                style={{ ...fontStyle(theme, 400), fontSize: 12, color: c["fg-muted"], flex: 1 }}
              >
                {command.provider === "connected_machine" ? m.onMachine : m.inSandbox} ·{" "}
                {command.state === "stopping" ? m.stopping : running ? m.running : m.finished}
              </Text>
              {running && !readOnly ? (
                <Button
                  label={m.stop}
                  icon="square"
                  size="sm"
                  onPress={() => void commands.cancel(command.id)}
                />
              ) : null}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

/** The compact signal chip shared by goal, agents, commands and the queue. */
export function signalChipStyle(theme: NativeTimelineTheme, pressed: boolean) {
  return {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 5,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 15,
    backgroundColor: pressed ? theme.colors.hover : theme.colors["surface-2"],
  };
}

export function signalChipText(theme: NativeTimelineTheme): TextStyle {
  return { ...fontStyle(theme, 500), fontSize: 13, color: theme.colors.fg };
}
