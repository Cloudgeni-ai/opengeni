import type { ClientModel, LineageNode, SessionBackgroundCommand } from "@opengeni/sdk";
import type { UseGoalResult } from "@opengeni/react/session";
import { sessionAgentsSignal, sessionGoalStateLabel } from "@opengeni/react/session-agents-model";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Button } from "./controls";
import { Icon, type NativeIconName } from "./icon";
import { SessionRow } from "./session-list";
import { BottomSheet } from "./sheet";
import { fontStyle, useNativeTimelineTheme, type NativeTimelineTheme } from "./theme";

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
  const [open, setOpen] = useState<"goal" | "agents" | "commands" | null>(null);
  const goal = props.goal?.goal ?? null;
  const agents = sessionAgentsSignal(props.agents);
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
            label="Goal"
            detail={sessionGoalStateLabel(goal)}
            tone={goal.status === "active" ? "running" : "neutral"}
            onPress={() => setOpen("goal")}
          />
        ) : null}
        {agents ? (
          <Chip
            icon="bot"
            label={`${agents.count} agent${agents.count === 1 ? "" : "s"}`}
            detail={agents.detail}
            tone={agents.tone}
            onPress={() => setOpen("agents")}
          />
        ) : null}
        {props.commandsCount > 0 ? (
          <Chip
            icon="terminal"
            label={`${props.commandsCount} command${props.commandsCount === 1 ? "" : "s"}`}
            detail="Running"
            tone="running"
            onPress={() => setOpen("commands")}
          />
        ) : null}
      </ScrollView>

      <BottomSheet open={open === "goal"} onClose={close} accessibilityLabel="Goal">
        {goal && props.goal ? <GoalPanel goal={props.goal} readOnly={props.readOnly} /> : null}
      </BottomSheet>
      <BottomSheet open={open === "agents"} onClose={close} accessibilityLabel="Agents">
        <SheetTitle>Agents</SheetTitle>
        <ScrollView style={{ paddingHorizontal: 12 }}>
          {props.agents.map((node) => (
            <View key={node.session.id}>
              <SessionRow
                session={node.session}
                models={props.models ?? []}
                onPress={() => {
                  close();
                  props.onOpenSession?.(node.session.id);
                }}
              />
              {node.children.map((child) => (
                <View key={child.session.id} style={{ paddingLeft: 18 }}>
                  <SessionRow
                    session={child.session}
                    models={props.models ?? []}
                    onPress={() => {
                      close();
                      props.onOpenSession?.(child.session.id);
                    }}
                  />
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      </BottomSheet>
      <BottomSheet open={open === "commands"} onClose={close} accessibilityLabel="Commands">
        <SheetTitle>Commands</SheetTitle>
        {open === "commands" ? props.renderCommands(close) : null}
      </BottomSheet>
    </>
  );
}

function Chip(props: {
  icon: NativeIconName;
  label: string;
  detail: string;
  tone: "running" | "waiting" | "neutral";
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
      style={({ pressed }) => signalChipStyle(theme, pressed)}
    >
      <Icon name={props.icon} size={13} color={c["fg-muted"]} />
      <Text style={signalChipText(theme)}>{props.label}</Text>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor }} />
    </Pressable>
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
  const c = theme.colors;
  const record = goal.goal!;
  const body = { ...fontStyle(theme, 400), fontSize: 15, lineHeight: 22, color: c.fg };
  const label = { ...fontStyle(theme, 600), fontSize: 12, color: c["fg-subtle"] };
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12, gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ ...fontStyle(theme, 600), fontSize: 17, color: c.fg }}>Goal</Text>
        <Text style={{ ...fontStyle(theme, 500), fontSize: 13, color: c["fg-muted"] }}>
          {sessionGoalStateLabel(record)}
        </Text>
      </View>
      <View style={{ gap: 4 }}>
        <Text style={label}>OBJECTIVE</Text>
        <Text style={body} selectable>
          {record.text}
        </Text>
      </View>
      {record.successCriteria ? (
        <View style={{ gap: 4 }}>
          <Text style={label}>DONE WHEN</Text>
          <Text style={body} selectable>
            {record.successCriteria}
          </Text>
        </View>
      ) : null}
      {record.status === "paused" && record.rationale ? (
        <View style={{ gap: 4 }}>
          <Text style={label}>WHY IT PAUSED</Text>
          <Text style={body}>{record.rationale}</Text>
        </View>
      ) : null}
      {record.status === "completed" && record.evidence ? (
        <View style={{ gap: 4 }}>
          <Text style={label}>EVIDENCE</Text>
          <Text style={body}>{record.evidence}</Text>
        </View>
      ) : null}
      {!readOnly && record.status !== "completed" ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {record.status === "active" ? (
            <Button
              label="Pause goal"
              icon="pause"
              busy={goal.updating}
              onPress={() => void goal.pause()}
            />
          ) : (
            <Button
              label="Resume goal"
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
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  if (commands.loading && commands.commands.length === 0) {
    return <ActivityIndicator style={{ padding: 24 }} />;
  }
  if (commands.commands.length === 0) {
    return (
      <Text style={{ ...fontStyle(theme, 400), color: c["fg-muted"], padding: 20 }}>
        No commands are running.
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
                {command.provider === "connected_machine" ? "On a machine" : "In the sandbox"} ·{" "}
                {command.state === "stopping" ? "Stopping" : running ? "Running" : "Finished"}
              </Text>
              {running && !readOnly ? (
                <Button
                  label="Stop"
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

export function signalChipText(theme: NativeTimelineTheme) {
  return { ...fontStyle(theme, 500), fontSize: 13, color: theme.colors.fg };
}
