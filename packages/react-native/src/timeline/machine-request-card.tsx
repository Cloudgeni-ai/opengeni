import { useOpenGeniText } from "@opengeni/react/messages";
import {
  isPersonalMachine,
  machineRequestName,
  machineRequestState,
  machineStateLabel,
  moveChatToMachine,
  swapFailureMessage,
  isMachineComputeSelectable,
  type MachineMoveChat,
} from "@opengeni/react/machine-request-model";
import { machineScopeLabel } from "@opengeni/react/sandbox-label-model";
import type { AuthNeededItem } from "@opengeni/react/session";
import type {
  MachineView,
  MachinesResponse,
  SendMessageInput,
  SwapActiveSandboxResponse,
} from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { DecisionActions, DecisionButton, DecisionCard } from "./decision-card";
import { Icon, type NativeIconName } from "./icon";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   An agent's request to use a Connected Machine, answered in the chat: the
   machine it asked for, Allow to move the chat there with the owner's
   consent, and the person's other machines to choose from. The same choices
   as the web card (shared from @opengeni/react/machine-request-model). A new
   computer connects from the computer itself, so connecting one stays a link
   to open this chat there.
   -------------------------------------------------------------------------- */

/** The calls the card makes; the SDK client has them all. */
export interface NativeMachineRequestClient {
  listMachines(workspaceId: string, options?: { sessionId?: string }): Promise<MachinesResponse>;
  swapActiveSandbox(
    workspaceId: string,
    sessionId: string,
    request: { target: string },
  ): Promise<SwapActiveSandboxResponse>;
  sendMessage(
    workspaceId: string,
    sessionId: string,
    message: SendMessageInput,
  ): Promise<{ payload?: unknown }>;
}

const NO_MACHINES: MachineView[] = [];

/** How often an open request rechecks the machines, so one turning on shows up. */
const POLL_MS = 15_000;

type Fleet =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "unavailable" }
  | { status: "ready"; machines: MachineView[] };

function useSessionMachines(
  client: NativeMachineRequestClient,
  workspaceId: string,
  sessionId: string,
  poll: boolean,
) {
  const [fleet, setFleet] = useState<Fleet>({ status: "loading" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    try {
      const response = await client.listMachines(workspaceId, { sessionId });
      if (alive.current) setFleet({ status: "ready", machines: response.machines });
    } catch (error) {
      if (!alive.current) return;
      const status = (error as { status?: unknown } | null)?.status;
      // A deployment without Connected Machines answers 404: say nothing more.
      setFleet((current) =>
        status === 404
          ? { status: "unavailable" }
          : current.status === "ready"
            ? current
            : { status: "failed" },
      );
    }
  }, [client, workspaceId, sessionId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!poll) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [poll, refresh]);
  return { fleet, refresh };
}

export function NativeMachineRequestCard({
  item,
  client,
  workspaceId,
  sessionId,
  chat,
  onShareConversation,
  onMoved,
  fallback,
}: {
  item: AuthNeededItem;
  client: NativeMachineRequestClient;
  workspaceId: string;
  sessionId: string;
  /** What a composer Send would carry now, read when the person chooses. */
  chat: () => MachineMoveChat;
  /** Share this chat's link, to connect another computer from that computer. */
  onShareConversation?: (() => void) | undefined;
  /** Re-read the session once the chat runs somewhere else. */
  onMoved?: (() => Promise<void> | void) | undefined;
  /** The plain card for a deployment without Connected Machines. */
  fallback: ReactNode;
}) {
  const t = useOpenGeniText();
  const [outcome, setOutcome] = useState<{ sandboxId: string; text: string } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [polling, setPolling] = useState(true);
  const { fleet, refresh } = useSessionMachines(client, workspaceId, sessionId, polling);
  const machines = fleet.status === "ready" ? fleet.machines : NO_MACHINES;
  const state = useMemo(
    () => machineRequestState({ item, machines, canAttach: true }),
    [item, machines],
  );
  // Polling only matters while the request is open.
  useEffect(() => setPolling(!state.complete), [state.complete]);
  const name = (machine: MachineView) => machineRequestName(t, machine);

  const use = useCallback(
    async (machine: MachineView) => {
      if (moving !== null) return;
      setError(null);
      setOutcome(null);
      setMoving(machine.sandboxId);
      const label = machineRequestName(t, machine);
      let refusal: string | null = null;
      const result = await moveChatToMachine({
        machine,
        name: label,
        chat: chat(),
        canMessage: true,
        previousSandboxId: state.active?.sandboxId ?? null,
        attach: async (target) => {
          try {
            const response = await client.swapActiveSandbox(workspaceId, sessionId, { target });
            if (response.swapped === false) {
              refusal = swapFailureMessage(t, response);
              return false;
            }
            return true;
          } catch {
            return false;
          }
        },
        sendMessage: (message) => client.sendMessage(workspaceId, sessionId, message),
      });
      await refresh();
      setMoving(null);
      if (!result.moved) {
        setError(
          t("native.timeline.machineRequest.couldNotMove", {
            name: label,
            reason: result.reason ?? refusal ?? t("native.timeline.machineRequest.tryAgain"),
          }),
        );
        return;
      }
      setOutcome({ sandboxId: machine.sandboxId, text: result.text });
      setSettingsOpen(false);
      await onMoved?.();
    },
    [chat, client, moving, onMoved, refresh, sessionId, state.active?.sandboxId, t, workspaceId],
  );

  if (fleet.status === "unavailable") return <>{fallback}</>;

  const { requested, asking, allowHere, active, reachable } = state;
  const complete = state.complete && moving === null && error === null;
  if (complete && active && !settingsOpen) {
    const label =
      outcome?.sandboxId === active.sandboxId &&
      outcome.text !== `This chat now runs on ${name(active)}.`
        ? outcome.text
        : t("native.timeline.machineRequest.usingName", { name: name(active) });
    return <MachineConfirmation label={label} onChange={() => setSettingsOpen(true)} />;
  }

  const requestedName = requested ? name(requested) : "";
  const sharedChat = chat().personalMachineIntent?.workspaceSharedAcknowledged === true;
  const ownMachine = allowHere !== null && isPersonalMachine(allowHere);
  const others = machines
    .filter((machine) => !machine.isSessionGroup && machine.enrollmentId)
    .filter((machine) => machine.sandboxId !== allowHere?.sandboxId)
    .sort((left, right) => rank(left) - rank(right) || name(left).localeCompare(name(right)));
  const folded = allowHere !== null && !othersOpen;
  const title = asking ? requestedName : item.capability?.name || "Connected Machine";
  const subtitle =
    asking && requested
      ? `${machineStateLabel(t, requested.state)} · ${machineScopeLabel(t, requested.scope)}`
      : t("native.timeline.machineRequest.subtitle");
  const description = ownMachine
    ? t("native.timeline.machineRequest.askedOwnMachine")
    : allowHere
      ? t("native.timeline.machineRequest.askedSharedMachine")
      : asking
        ? t("native.timeline.machineRequest.askedForName", { name: requestedName })
        : (item.capability?.rationale ?? "");
  const status =
    fleet.status === "loading" || allowHere
      ? null
      : fleet.status === "failed"
        ? t("native.timeline.machineRequest.couldNotLoad")
        : asking && requested && !isMachineComputeSelectable(requested.state)
          ? t("native.timeline.machineRequest.turnOnName", { name: requestedName })
          : reachable.length > 0
            ? t("native.timeline.machineRequest.chooseWhere")
            : machines.length > 0
              ? t("native.timeline.machineRequest.turnOnOne")
              : null;
  const note = allowHere
    ? ownMachine && sharedChat
      ? t("native.timeline.machineRequest.ownMachineSharedNote")
      : ownMachine
        ? t("native.timeline.machineRequest.ownMachineNote")
        : null
    : null;
  return (
    <DecisionCard settled={false} style={{ padding: 16, gap: 12 }}>
      <Header title={title} subtitle={subtitle} />
      {description ? <Line tone="body">{description}</Line> : null}
      {fleet.status === "loading" ? (
        <ActivityIndicator style={{ alignSelf: "flex-start" }} />
      ) : null}
      {status ? (
        <Line icon={fleet.status === "failed" ? "circle-alert" : undefined} role="status">
          {status}
        </Line>
      ) : null}
      {error ? (
        <Line tone="error" icon="circle-alert" role="alert">
          {error}
        </Line>
      ) : null}
      {allowHere ? (
        <DecisionActions
          primary={
            <DecisionButton
              kind="primary"
              icon="check"
              label={
                moving === allowHere.sandboxId
                  ? t("native.timeline.machineRequest.allowing")
                  : t("native.timeline.machineRequest.allow")
              }
              busy={moving === allowHere.sandboxId}
              disabled={moving !== null}
              onPress={() => void use(allowHere)}
            />
          }
        />
      ) : fleet.status === "failed" ? (
        <DecisionActions
          primary={
            <DecisionButton
              icon="rotate-ccw"
              label={t("sessionIntegrationCapabilityCard.retry")}
              onPress={() => void refresh()}
            />
          }
        />
      ) : null}
      {note ? <Line tone="small">{note}</Line> : null}
      {allowHere && others.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: othersOpen }}
          onPress={() => setOthersOpen((open) => !open)}
          hitSlop={8}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32 }}
        >
          <View style={{ transform: [{ rotate: othersOpen ? "90deg" : "0deg" }] }}>
            <MutedIcon name="chevron-right" />
          </View>
          <Line>{t("native.timeline.machineRequest.useDifferent")}</Line>
        </Pressable>
      ) : null}
      {!folded && others.length > 0 ? (
        <View style={{ gap: 2 }}>
          {others.map((machine) => (
            <MachineRow
              key={machine.sandboxId}
              machine={machine}
              name={name(machine)}
              busy={moving === machine.sandboxId}
              locked={moving !== null}
              onUse={() => void use(machine)}
            />
          ))}
        </View>
      ) : null}
      {onShareConversation && fleet.status !== "loading" ? (
        <View style={{ gap: 8 }}>
          <Line tone="small">{t("native.timeline.machineRequest.connectAnother")}</Line>
          <DecisionActions
            primary={
              <DecisionButton
                icon="share-2"
                label={t("thisComputer.card.shareConversation")}
                onPress={onShareConversation}
              />
            }
          />
        </View>
      ) : null}
    </DecisionCard>
  );
}

/** Machines the chat runs on or could move to first; offline ones last. */
function rank(machine: MachineView): number {
  return machine.active ? 0 : isMachineComputeSelectable(machine.state) ? 1 : 2;
}

/**
 * An earlier machine request the agent made again further down: the newer
 * card is the live one, so this stays one quiet line.
 */
export function NativeRepeatedMachineRequestNote({ chrome }: { chrome: boolean }) {
  const t = useOpenGeniText();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <MutedIcon name="laptop" />
      <Line tone="small">
        {chrome
          ? t("native.timeline.machineRequest.askedAgainChrome")
          : t("native.timeline.machineRequest.askedAgain")}
      </Line>
    </View>
  );
}

/** An earlier card for a connection the agent asked for again further down. */
export function NativeRepeatedCapabilityRequestNote({ name }: { name: string }) {
  const t = useOpenGeniText();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <MutedIcon name="plug" />
      <Line tone="small">{t("native.timeline.inChatConnect.askedAgain", { name })}</Line>
    </View>
  );
}

/** The chat runs on the machine it needs: one quiet line, Change reopens the choice. */
function MachineConfirmation({ label, onChange }: { label: string; onChange: () => void }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <MutedIcon name="check" />
      <Text
        accessibilityLiveRegion="polite"
        style={{
          ...fontStyle(theme),
          flex: 1,
          fontSize: theme.size.base,
          lineHeight: 20,
          color: theme.colors["fg-muted"],
        }}
      >
        {label}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={onChange}
        hitSlop={8}
        style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}
      >
        <Text style={{ ...fontStyle(theme, 500), fontSize: theme.size.sm, color: theme.colors.fg }}>
          {t("native.timeline.machineRequest.change")}
        </Text>
      </Pressable>
    </View>
  );
}

function MachineRow({
  machine,
  name,
  busy,
  locked,
  onUse,
}: {
  machine: MachineView;
  name: string;
  busy: boolean;
  locked: boolean;
  onUse: () => void;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const selectable = isMachineComputeSelectable(machine.state);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 52,
        borderTopWidth: 1,
        borderTopColor: c.border,
        paddingTop: 8,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c["surface-1"],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={machine.hasDisplay ? "laptop" : "server"} size={15} color={c["fg-muted"]} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{ ...fontStyle(theme, 500), fontSize: theme.size.base, color: c.fg }}
        >
          {name}
        </Text>
        <Text
          numberOfLines={1}
          style={{ ...fontStyle(theme), fontSize: theme.size.sm, color: c["fg-muted"] }}
        >
          {`${machineStateLabel(t, machine.state)} · ${machineScopeLabel(t, machine.scope)}`}
        </Text>
      </View>
      {machine.active ? (
        <Text style={{ ...fontStyle(theme, 500), fontSize: theme.size.sm, color: c["fg-muted"] }}>
          {t("native.timeline.machineRequest.inUse")}
        </Text>
      ) : selectable ? (
        <View style={{ minWidth: 76 }}>
          <DecisionButton
            label={
              busy
                ? t("native.timeline.machineRequest.moving")
                : t("native.timeline.machineRequest.use")
            }
            accessibilityLabel={`${t("native.timeline.machineRequest.use")} ${name}`}
            busy={busy}
            disabled={locked}
            onPress={onUse}
          />
        </View>
      ) : null}
    </View>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: 36,
          height: 36,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c["surface-1"],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="laptop" size={18} color={c["fg-muted"]} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          accessibilityRole="header"
          numberOfLines={2}
          style={{ ...fontStyle(theme, 600), fontSize: theme.size.md, lineHeight: 21, color: c.fg }}
        >
          {title}
        </Text>
        <Text
          numberOfLines={1}
          style={{ ...fontStyle(theme), fontSize: theme.size.sm, color: c["fg-muted"] }}
        >
          {subtitle}
        </Text>
      </View>
    </View>
  );
}

function MutedIcon({ name }: { name: NativeIconName }) {
  const theme = useNativeTimelineTheme();
  return <Icon name={name} size={14} color={theme.colors["fg-subtle"]} />;
}

function Line({
  children,
  tone = "muted",
  icon,
  role,
}: {
  children: ReactNode;
  tone?: "body" | "muted" | "small" | "error";
  icon?: NativeIconName | undefined;
  role?: "status" | "alert" | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const color = tone === "error" ? c["status-failed"] : tone === "body" ? c.fg : c["fg-muted"];
  const size = tone === "small" ? theme.size.sm : theme.size.base;
  const line = (
    <Text
      accessibilityRole={role === "alert" ? "alert" : undefined}
      accessibilityLiveRegion={role === "alert" ? "assertive" : role ? "polite" : undefined}
      style={{
        ...fontStyle(theme),
        flexShrink: 1,
        fontSize: size,
        lineHeight: tone === "small" ? 17 : 20,
        color,
      }}
    >
      {children}
    </Text>
  );
  if (!icon) return line;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
      <View style={{ paddingTop: 3 }}>
        <Icon
          name={icon}
          size={13}
          color={tone === "error" ? c["status-failed"] : c["fg-subtle"]}
        />
      </View>
      {line}
    </View>
  );
}
