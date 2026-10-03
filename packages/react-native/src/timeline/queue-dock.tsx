import type { useTurnQueue } from "@opengeni/react/session";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Icon } from "./icon";
import { withAlpha } from "./primitives";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   The web queue dock above the composer: a "N queued · Steer" chip and the
   queued prompts with Steer (interrupt and send now) and Delete. Reordering
   and edit-in-composer stay on the web for now.
   -------------------------------------------------------------------------- */

type TurnQueue = ReturnType<typeof useTurnQueue>;

export function QueueDock({ queue }: { queue: TurnQueue }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [open, setOpen] = useState(true);
  const turns = queue.queue;
  if (turns.length === 0) return null;
  const first = turns[0]!;
  const small = { ...fontStyle(theme, 500), fontSize: theme.size.sm, color: c["fg-muted"] };
  const steer = (turnId: string) => void queue.steerTurn(turnId);
  return (
    <View style={{ gap: 6, paddingBottom: 8 }}>
      <View
        style={{
          alignSelf: "flex-start",
          flexDirection: "row",
          alignItems: "center",
          borderRadius: theme.radius.md,
          backgroundColor: c["surface-2"],
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${turns.length} queued prompt${turns.length === 1 ? "" : "s"}`}
          onPress={() => setOpen((value) => !value)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            minHeight: 36,
            paddingHorizontal: 10,
          }}
        >
          <Icon name="list-ordered" size={14} color={c["fg-muted"]} />
          <Text style={small}>{`${turns.length} queued`}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Steer queued prompt 1"
          disabled={queue.mutationFor(first.id) !== null}
          onPress={() => steer(first.id)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            minHeight: 36,
            paddingHorizontal: 10,
          }}
        >
          <Icon name="corner-down-right" size={14} color={c["fg-muted"]} />
          <Text style={small}>Steer</Text>
        </Pressable>
      </View>
      {open ? (
        <View
          style={{
            borderRadius: theme.radius.md,
            backgroundColor: withAlpha(c["surface-2"], 0.6),
            overflow: "hidden",
          }}
        >
          {turns.map((turn, index) => {
            const pending = queue.mutationFor(turn.id);
            return (
              <View
                key={turn.id}
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: 8,
                  paddingLeft: 12,
                  paddingRight: 4,
                  paddingVertical: 4,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: c.border,
                }}
              >
                <Text
                  style={{
                    ...fontStyle(theme, 400, "mono"),
                    marginTop: 12,
                    fontSize: theme.size.xs,
                    color: c["fg-subtle"],
                  }}
                >
                  {index + 1}
                </Text>
                <Text
                  numberOfLines={3}
                  style={{
                    ...fontStyle(theme),
                    flex: 1,
                    marginTop: 10,
                    fontSize: theme.size.sm,
                    lineHeight: 18,
                    color: c.fg,
                  }}
                >
                  {turn.prompt}
                </Text>
                {pending ? (
                  <View
                    style={{
                      width: 44,
                      height: 44,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <ActivityIndicator size="small" color={c["fg-muted"]} />
                  </View>
                ) : (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Steer queued prompt ${index + 1}`}
                      onPress={() => steer(turn.id)}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 4,
                        minHeight: 44,
                        paddingHorizontal: 8,
                      }}
                    >
                      <Icon name="corner-down-right" size={14} color={c["fg-muted"]} />
                      <Text style={small}>Steer</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Delete queued prompt ${index + 1}`}
                      onPress={() => void queue.removeTurn(turn.id)}
                      style={{
                        width: 44,
                        height: 44,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Icon name="trash-2" size={14} color={c["fg-muted"]} />
                    </Pressable>
                  </>
                )}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
