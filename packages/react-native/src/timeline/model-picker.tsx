import type { ClientModel, LatencyMode, ReasoningEffort } from "@opengeni/sdk";
import {
  compactEffortLabel,
  groupPresentationFor,
  modelPickerChoice,
  modelPickerMenuView,
  type ModelPickerGroupPresentation,
  type ModelPickerInput,
} from "@opengeni/react/model-picker-model";
import { labelReasoningEffort, type PickerBillingClass } from "@opengeni/react/model-policy";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Icon, type NativeIconName } from "./icon";
import { ModelMark } from "./session-list";
import { BottomSheet } from "./sheet";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   The web composer's model menu as a native sheet: search, payment groups with
   maker marks, the selected check, unavailable rows with their reason, and the
   Thinking segmented control with Fast. Everything it shows comes from the
   shared model picker model; only the chrome is native.
   -------------------------------------------------------------------------- */

export type ModelPickerSheetProps = ModelPickerInput<ReactNode> & {
  open: boolean;
  onClose: () => void;
  loading?: boolean | undefined;
  error?: string | null | undefined;
  disabled?: boolean | undefined;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: ReasoningEffort) => void;
  onLatencyModeChange: (mode: LatencyMode) => void;
  /** Called after a choice, for host haptics. */
  onSelectionFeedback?: (() => void) | undefined;
};

const GROUP_ICON: Record<PickerBillingClass, NativeIconName> = {
  opengeni_credits: "sparkles",
  external: "globe",
  codex_subscription: "sparkles",
  claude_subscription: "sparkles",
  supergrok_subscription: "sparkles",
  byok: "key-round",
  organization_byok: "key-round",
};

/** The subscription rails carry their maker's mark, as on web. */
const GROUP_MARK_MODEL: Partial<Record<PickerBillingClass, string>> = {
  codex_subscription: "codex/gpt",
  claude_subscription: "claude",
  supergrok_subscription: "grok",
};

function GroupMark(props: {
  billingClass: PickerBillingClass;
  icon: ReactNode | undefined;
  color: string;
}) {
  if (props.icon === null) return null;
  if (props.icon !== undefined) return <>{props.icon}</>;
  const model = GROUP_MARK_MODEL[props.billingClass];
  if (model) return <ModelMark model={model} size={14} color={props.color} />;
  return <Icon name={GROUP_ICON[props.billingClass]} size={14} color={props.color} />;
}

export function ModelPickerSheet(props: ModelPickerSheetProps) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [query, setQuery] = useState("");
  const view = modelPickerMenuView(props, query);
  const { messages, groups, thinking } = view;
  const close = () => {
    setQuery("");
    props.onClose();
  };
  const choose = (row: (typeof view.rows)[number]) => {
    if (props.disabled) return;
    const choice = modelPickerChoice(props, row);
    if (!choice) return;
    if (choice.model !== null) props.onModelChange(choice.model);
    props.onEffortChange(choice.effort);
    if (choice.latencyMode !== null) props.onLatencyModeChange(choice.latencyMode);
    props.onSelectionFeedback?.();
  };
  const label = { ...fontStyle(theme), fontSize: 15, color: c.fg };
  const muted = { ...fontStyle(theme), fontSize: 13, color: c["fg-muted"] };
  return (
    <BottomSheet open={props.open} onClose={close} accessibilityLabel={messages.label}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 20,
          paddingTop: 0,
          paddingBottom: 6,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{ ...fontStyle(theme, 600), fontSize: 17, color: c.fg }}
        >
          {messages.label}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Done"
          onPress={close}
          hitSlop={8}
          style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 4 }}
        >
          <Text style={{ ...fontStyle(theme, 600), fontSize: 16, color: c.accent }}>Done</Text>
        </Pressable>
      </View>
      {view.anySelectable ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginHorizontal: 16,
            marginBottom: 4,
            paddingHorizontal: 12,
            minHeight: 40,
            borderRadius: theme.radius.md,
            backgroundColor: c["surface-2"],
          }}
        >
          <Icon name="search" size={16} color={c["fg-subtle"]} />
          <TextInput
            accessibilityLabel={messages.searchLabel}
            placeholder={messages.searchPlaceholder}
            placeholderTextColor={c["fg-subtle"]}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            style={{
              ...fontStyle(theme),
              flex: 1,
              fontSize: 16,
              color: c.fg,
              paddingVertical: 8,
            }}
          />
        </View>
      ) : null}
      {props.error ? (
        <Text
          accessibilityRole="alert"
          style={{
            ...muted,
            color: c["status-failed"],
            paddingHorizontal: 20,
            paddingVertical: 6,
          }}
        >
          {props.error}
        </Text>
      ) : null}
      <ScrollView
        style={{ flexGrow: 0 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingVertical: 4 }}
      >
        {props.loading ? (
          <View accessibilityRole="progressbar" accessibilityLabel={messages.loading}>
            {[58, 44, 66, 50].map((width) => (
              <View
                key={width}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  height: 48,
                  paddingHorizontal: 20,
                }}
              >
                <View
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    backgroundColor: c["surface-2"],
                  }}
                />
                <View
                  style={{
                    height: 10,
                    width: `${width}%`,
                    borderRadius: 4,
                    backgroundColor: c["surface-2"],
                  }}
                />
              </View>
            ))}
          </View>
        ) : view.anySelectable ? (
          <>
            {groups.map((group, index) => (
              <View
                key={group.billingClass}
                accessibilityLabel={group.label}
                style={
                  index > 0
                    ? {
                        marginTop: 6,
                        paddingTop: 6,
                        borderTopWidth: 1,
                        borderTopColor: c.border,
                      }
                    : undefined
                }
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    paddingHorizontal: 20,
                    paddingTop: 8,
                    paddingBottom: 2,
                  }}
                >
                  <GroupMark
                    billingClass={group.billingClass}
                    icon={groupPresentationFor(props, group.billingClass)?.icon}
                    color={c["fg-subtle"]}
                  />
                  <Text style={{ ...fontStyle(theme, 500), fontSize: 13, color: c["fg-muted"] }}>
                    {group.label}
                  </Text>
                </View>
                {group.description ? (
                  <Text style={{ ...muted, paddingHorizontal: 20, paddingBottom: 4 }}>
                    {group.description}
                  </Text>
                ) : null}
                {group.rows.map((row) => {
                  const active = row.selectable && row.id === props.model;
                  const enabled = row.selectable && !props.disabled;
                  return (
                    <Pressable
                      key={row.id}
                      accessibilityRole="button"
                      accessibilityLabel={[row.label, row.unavailableReason]
                        .filter(Boolean)
                        .join(", ")}
                      accessibilityState={{ selected: active, disabled: !enabled }}
                      disabled={!enabled}
                      onPress={() => choose(row)}
                      style={({ pressed }) => ({
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 12,
                        minHeight: 48,
                        paddingHorizontal: 20,
                        paddingVertical: 6,
                        backgroundColor: pressed ? c.hover : "transparent",
                        opacity: row.selectable ? 1 : 0.5,
                      })}
                    >
                      {props.collapseScopes === false ? null : (
                        <ModelMark model={row.id} size={18} color={c["fg-muted"]} />
                      )}
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1} style={label}>
                          {row.label}
                        </Text>
                        {row.unavailableReason ? (
                          <Text numberOfLines={2} style={muted}>
                            {row.unavailableReason}
                          </Text>
                        ) : null}
                      </View>
                      {row.catalog.cost === "free" ? (
                        <Text
                          style={{
                            ...muted,
                            fontSize: 12,
                            paddingHorizontal: 8,
                            paddingVertical: 2,
                            borderRadius: 999,
                            overflow: "hidden",
                            backgroundColor: c["surface-2"],
                          }}
                        >
                          {messages.free}
                        </Text>
                      ) : null}
                      {row.id === props.model ? <Icon name="check" size={18} color={c.fg} /> : null}
                    </Pressable>
                  );
                })}
              </View>
            ))}
            {view.matchCount === 0 ? (
              <Text style={{ ...muted, paddingHorizontal: 20, paddingVertical: 12 }}>
                {view.searching ? messages.noMatches : messages.noModels}
              </Text>
            ) : null}
          </>
        ) : (
          <View style={{ paddingHorizontal: 20, paddingVertical: 12, gap: 4 }}>
            <Text style={{ ...fontStyle(theme, 500), fontSize: 15, color: c.fg }}>
              {messages.connectTitle}
            </Text>
            <Text style={muted}>
              {view.rows.length > 0 ? messages.connectBody : messages.noModels}
            </Text>
          </View>
        )}
      </ScrollView>
      {view.anySelectable && view.selected && (view.unsupportedAttachments || thinking) ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: c.border,
            paddingHorizontal: 20,
            paddingTop: 12,
            gap: 8,
          }}
        >
          {view.unsupportedAttachments ? (
            <Text style={{ ...muted, color: c["fg-subtle"] }}>
              {messages.unsupportedAttachments}
            </Text>
          ) : null}
          {thinking ? (
            <>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  minHeight: 32,
                }}
              >
                {thinking.showThinking ? (
                  <Text style={{ ...muted, color: c["fg-subtle"] }}>{messages.thinking}</Text>
                ) : (
                  <View />
                )}
                {thinking.showFast ? (
                  <Pressable
                    accessibilityRole="switch"
                    accessibilityLabel={`${messages.fast}, ${messages.fastRateHint}`}
                    accessibilityState={{
                      checked: props.latencyMode === "fast",
                      disabled: Boolean(props.disabled || thinking.disabled),
                    }}
                    disabled={props.disabled || thinking.disabled}
                    onPress={() => {
                      props.onLatencyModeChange(props.latencyMode === "fast" ? "standard" : "fast");
                      props.onSelectionFeedback?.();
                    }}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      minHeight: 36,
                      paddingHorizontal: 8,
                      borderRadius: theme.radius.sm,
                      backgroundColor: pressed ? c.hover : "transparent",
                    })}
                  >
                    <Icon
                      name="zap"
                      size={14}
                      color={c["fg-muted"]}
                      fill={props.latencyMode === "fast" ? c["fg-muted"] : undefined}
                    />
                    <Text style={muted}>{messages.fast}</Text>
                    <Text style={{ ...muted, color: c["fg-subtle"] }}>{messages.fastRateHint}</Text>
                  </Pressable>
                ) : null}
              </View>
              {thinking.showThinking ? (
                <View
                  accessibilityRole="radiogroup"
                  accessibilityLabel={messages.thinkingEffort}
                  style={{
                    flexDirection: "row",
                    gap: 2,
                    padding: 2,
                    borderRadius: theme.radius.md,
                    backgroundColor: c["surface-2"],
                  }}
                >
                  {thinking.efforts.map((effort) => {
                    const checked = effort === thinking.value;
                    const disabled = Boolean(props.disabled || thinking.disabled);
                    return (
                      <Pressable
                        key={effort}
                        accessibilityRole="radio"
                        accessibilityLabel={labelReasoningEffort(effort)}
                        accessibilityState={{ checked, disabled }}
                        disabled={disabled}
                        onPress={() => {
                          if (checked) return;
                          props.onEffortChange(effort);
                          props.onSelectionFeedback?.();
                        }}
                        style={{
                          flex: 1,
                          minHeight: 36,
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: theme.radius.sm,
                          backgroundColor: checked ? c["surface-1"] : "transparent",
                          opacity: disabled ? 0.5 : 1,
                          ...(checked
                            ? {
                                shadowColor: "#000",
                                shadowOpacity: 0.06,
                                shadowRadius: 2,
                                shadowOffset: { width: 0, height: 1 },
                                elevation: 1,
                              }
                            : null),
                        }}
                      >
                        <Text
                          numberOfLines={1}
                          style={{
                            ...fontStyle(theme),
                            fontSize: 13,
                            color: checked ? c.fg : c["fg-muted"],
                          }}
                        >
                          {compactEffortLabel(effort, labelReasoningEffort(effort))}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}
    </BottomSheet>
  );
}

export type { ClientModel, ModelPickerGroupPresentation };
