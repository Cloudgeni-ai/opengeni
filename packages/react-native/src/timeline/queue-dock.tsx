import type { ComposerDraft, SessionTurn } from "@opengeni/sdk";
import type { useTurnQueue } from "@opengeni/react/session";
import {
  isAuthoritativeQueuedTurn,
  QUEUE_ITEM_CONTENT_UNAVAILABLE,
  QUEUE_REPLACE_DRAFT_COPY,
  queueItemContent,
  queuedTurnPresentation,
  queueNeighborAnchors,
} from "@opengeni/react/queue-presentation-model";
import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Button } from "./controls";
import { Icon, type NativeIconName } from "./icon";
import { blendOver, withAlpha } from "./primitives";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   The web session-chrome queue dock above the composer: a "N queued · Steer"
   chip, then each waiting prompt on one line with Move up/down, Steer, Edit
   (back into the composer, confirming before it replaces a draft) and Remove.
   Which turns count, their text and the move anchors are the shared queue
   model.
   -------------------------------------------------------------------------- */

type TurnQueue = ReturnType<typeof useTurnQueue>;

/** The composer surface the dock checks prompts out into. */
export interface QueueDockComposer {
  draftRevision: number;
  hasDraftContent: () => boolean;
  applyDraft: (draft: ComposerDraft) => void;
  draftPersistence?: "durable" | "disabled" | undefined;
}

export function QueueDock({
  queue,
  composer,
  onComposerFocus,
  leading,
}: {
  queue: TurnQueue;
  composer?: QueueDockComposer | undefined;
  onComposerFocus?: (() => void) | undefined;
  /** Chips sharing the queue chip's row (goal, agents, commands). */
  leading?: ReactNode;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [open, setOpen] = useState(true);
  const [replaceDraftFor, setReplaceDraftFor] = useState<string | null>(null);
  const turns = useMemo(
    () => queue.queue.filter((turn) => isAuthoritativeQueuedTurn(turn, queue.mutationFor)),
    [queue.mutationFor, queue.queue],
  );
  if (turns.length === 0) {
    return leading ? <View style={{ flexDirection: "row" }}>{leading}</View> : null;
  }
  const first = turns[0]!;
  // The compact signal chip text (goal, agents and the queue share one row).
  const small = { ...fontStyle(theme, 500), fontSize: 13, color: c.fg };
  const canEdit = composer !== undefined && composer.draftPersistence !== "disabled";
  const checkout = async (turnId: string, replaceDraft: boolean) => {
    if (!composer) return;
    const draft = await queue.editTurn(turnId, {
      expectedDraftRevision: composer.draftRevision,
      replaceDraft,
    });
    if (draft) {
      composer.applyDraft(draft);
      onComposerFocus?.();
    }
  };
  const edit = (turn: SessionTurn) => {
    if (!composer) return;
    if (composer.hasDraftContent()) setReplaceDraftFor(turn.id);
    else void checkout(turn.id, false);
  };
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {leading}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            height: 30,
            borderRadius: 15,
            backgroundColor: c["surface-2"],
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={`${turns.length} queued prompt${turns.length === 1 ? "" : "s"}`}
            onPress={() => setOpen((value) => !value)}
            hitSlop={{ top: 7, bottom: 7 }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              height: 30,
              paddingLeft: 10,
              paddingRight: 6,
            }}
          >
            <Icon name="list-ordered" size={13} color={c["fg-muted"]} />
            <Text style={small}>{`${turns.length} queued`}</Text>
          </Pressable>
          <View style={{ width: 1, height: 14, backgroundColor: c.border }} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Steer first queued message"
            disabled={queue.mutating || queue.mutationFor(first.id) !== null}
            onPress={() => void queue.steerTurn(first.id)}
            hitSlop={{ top: 7, bottom: 7 }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              height: 30,
              paddingLeft: 6,
              paddingRight: 10,
            }}
          >
            <Icon name="corner-down-right" size={13} color={c["fg-muted"]} />
            <Text style={small}>Steer</Text>
          </Pressable>
        </View>
      </View>
      {open ? (
        <View
          accessibilityLabel="Queued prompts"
          style={{
            borderRadius: theme.radius.lg,
            // Opaque: the dock floats over scrolling conversation.
            backgroundColor: blendOver(c.bg, c["surface-2"], 0.6),
            paddingHorizontal: 8,
            paddingVertical: 2,
          }}
        >
          {turns.map((turn, index) => {
            const presentation = queuedTurnPresentation(turn);
            const voice = presentation.kind !== "prompt";
            const pending = queue.mutationFor(turn.id);
            const busy = pending !== null;
            const { beforeUp, beforeDown } = queueNeighborAnchors(turns, index);
            const annotationCount = turn.annotations?.length ?? 0;
            const content = queueItemContent(presentation.text, annotationCount);
            const label =
              content === "text"
                ? presentation.text
                : content === "annotations"
                  ? `${annotationCount} timeline annotation${annotationCount === 1 ? "" : "s"}`
                  : QUEUE_ITEM_CONTENT_UNAVAILABLE;
            return (
              <View key={turn.id} style={{ gap: 4 }}>
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 6 }}
                >
                  {voice ? (
                    <Icon name="audio-lines" size={12} color={c.accent} />
                  ) : (
                    <Text
                      style={{
                        ...fontStyle(theme, 400, "mono"),
                        fontSize: 10,
                        color: c["fg-subtle"],
                      }}
                    >
                      {index + 1}
                    </Text>
                  )}
                  <Text
                    numberOfLines={1}
                    style={{
                      ...fontStyle(theme),
                      flex: 1,
                      fontSize: theme.size.xs,
                      lineHeight: 16,
                      color: content === "unavailable" ? c["fg-muted"] : c.fg,
                      fontStyle: content === "unavailable" ? "italic" : "normal",
                    }}
                  >
                    {label}
                  </Text>
                  {turns.length > 1 ? (
                    <>
                      <RowAction
                        icon="arrow-up"
                        label={`Move queued prompt ${index + 1} up`}
                        disabled={busy || index === 0}
                        onPress={() => void queue.moveTurn(turn.id, beforeUp)}
                      />
                      <RowAction
                        icon="arrow-down"
                        label={`Move queued prompt ${index + 1} down`}
                        disabled={busy || index >= turns.length - 1}
                        onPress={() => void queue.moveTurn(turn.id, beforeDown)}
                      />
                    </>
                  ) : null}
                  <RowAction
                    icon="corner-down-right"
                    label={`Steer queued prompt ${index + 1}`}
                    disabled={busy}
                    busy={pending === "steer"}
                    onPress={() => void queue.steerTurn(turn.id)}
                  />
                  {canEdit ? (
                    <RowAction
                      icon="pencil"
                      label={`Edit queued prompt ${index + 1}`}
                      disabled={busy}
                      busy={pending === "edit"}
                      onPress={() => edit(turn)}
                    />
                  ) : null}
                  <RowAction
                    icon="trash-2"
                    label={`Remove queued prompt ${index + 1}`}
                    disabled={busy}
                    busy={pending === "delete"}
                    onPress={() => void queue.removeTurn(turn.id)}
                  />
                </View>
                {replaceDraftFor === turn.id ? (
                  <View
                    style={{
                      gap: 4,
                      padding: 8,
                      marginBottom: 4,
                      borderRadius: theme.radius.sm,
                      borderWidth: 1,
                      borderColor: withAlpha(c["status-waiting"], 0.3),
                      backgroundColor: withAlpha(c["status-waiting"], 0.1),
                    }}
                  >
                    <Text style={{ ...fontStyle(theme), fontSize: theme.size.xs, color: c.fg }}>
                      {QUEUE_REPLACE_DRAFT_COPY.title}
                    </Text>
                    <Text
                      style={{ ...fontStyle(theme), fontSize: theme.size.xs, color: c["fg-muted"] }}
                    >
                      {QUEUE_REPLACE_DRAFT_COPY.detail}
                    </Text>
                    <View
                      style={{
                        flexDirection: "row",
                        justifyContent: "flex-end",
                        gap: 6,
                        marginTop: 4,
                      }}
                    >
                      <Button
                        label={QUEUE_REPLACE_DRAFT_COPY.keep}
                        variant="ghost"
                        onPress={() => setReplaceDraftFor(null)}
                      />
                      <Button
                        label={QUEUE_REPLACE_DRAFT_COPY.replace}
                        variant="primary"
                        onPress={() => {
                          setReplaceDraftFor(null);
                          void checkout(turn.id, true);
                        }}
                      />
                    </View>
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
      {queue.mutationError ? (
        <Pressable accessibilityRole="alert" onPress={queue.clearMutationError}>
          <Text style={{ ...fontStyle(theme), fontSize: theme.size.xs, color: c["status-failed"] }}>
            {queue.mutationError.message}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A web IconAction at touch size: icon, optional text, a spinner while busy. */
function RowAction(props: {
  icon: NativeIconName;
  label: string;
  text?: string | undefined;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  onPress: () => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: Boolean(props.disabled), busy: Boolean(props.busy) }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        minWidth: 30,
        height: 32,
        paddingHorizontal: props.text ? 6 : 0,
        borderRadius: theme.radius.sm,
        backgroundColor: pressed ? c.hover : "transparent",
        opacity: props.disabled && !props.busy ? 0.4 : 1,
      })}
    >
      {props.busy ? (
        <ActivityIndicator size="small" color={c["fg-muted"]} />
      ) : (
        <Icon name={props.icon} size={14} color={c.fg} />
      )}
      {props.text ? (
        <Text style={{ ...fontStyle(theme), fontSize: theme.size.xs, color: c.fg }}>
          {props.text}
        </Text>
      ) : null}
    </Pressable>
  );
}
