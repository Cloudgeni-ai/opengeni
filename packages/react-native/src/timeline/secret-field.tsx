import type { HumanInputQuestion, HumanInputSecretSaveTo } from "@opengeni/sdk";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Button } from "./controls";
import { Icon } from "./icon";
import { Selector } from "./selector";
import {
  SECRET_SAVE_TO_OPTIONS,
  secretInputTraits,
  secretPatternMismatch,
  secretUsernameTraits,
  type SecretDraft,
  type SecretFieldMessages,
} from "./secret-field-model";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   The secret question's controls: optional username, a secure value field
   (show / hide, OS autofill traits from the spec), Generate, the soft
   looksLike / pattern hints, and Save to. The value never enters React
   state: the input is uncontrolled and each change goes to the form's ref.
   -------------------------------------------------------------------------- */

export interface SecretQuestionFieldProps {
  question: HumanInputQuestion;
  draft: SecretDraft;
  onDraft: (next: (draft: SecretDraft) => SecretDraft) => void;
  /** Receives every keystroke; the form keeps it in a ref, not state. */
  onValue: (value: string) => void;
  /** The form calls this to empty the field after a successful submit. */
  registerClear: (clear: (() => void) | null) => void;
  messages: SecretFieldMessages;
  error?: string | undefined;
  disabled: boolean;
}

export function SecretQuestionField({
  question,
  draft,
  onDraft,
  onValue,
  registerClear,
  messages,
  error,
  disabled,
}: SecretQuestionFieldProps) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const spec = question.secret;
  const traits = secretInputTraits(spec);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [revealed, setRevealed] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const defaultSaveTo = spec?.saveTo ?? "user";

  useEffect(() => {
    registerClear(() => {
      input.current?.clear();
      setMismatch(false);
      setRevealed(false);
    });
    return () => registerClear(null);
  }, [registerClear]);

  const change = (text: string) => {
    onValue(text);
    const next = secretPatternMismatch(spec?.pattern, text);
    setMismatch((current) => (current === next ? current : next));
  };
  const generate = () => {
    input.current?.clear();
    onValue("");
    setMismatch(false);
    setRevealed(false);
    onDraft((current) => ({ ...current, generate: true }));
  };
  const undo = () => onDraft((current) => ({ ...current, generate: false }));

  const label = { ...fontStyle(theme, 500), fontSize: theme.size.sm, lineHeight: 18, color: c.fg };
  const note = { ...fontStyle(theme), fontSize: theme.size.xs, lineHeight: 16 };
  const frame = {
    minHeight: 44,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c["surface-1"],
  };
  const valueFrame = { ...frame, borderColor: error ? c["status-failed"] : c.border };
  const text = { ...fontStyle(theme), fontSize: theme.size.sm, color: c.fg };

  return (
    <View style={{ gap: 10 }}>
      {spec?.username ? (
        <View style={{ gap: 6 }}>
          <Text style={label}>{spec.username.prompt}</Text>
          <TextInput
            {...secretUsernameTraits}
            accessibilityLabel={spec.username.prompt}
            editable={!disabled}
            value={draft.username}
            onChangeText={(username) => onDraft((current) => ({ ...current, username }))}
            returnKeyType="next"
            onSubmitEditing={() => input.current?.focus()}
            placeholderTextColor={c["fg-subtle"]}
            style={{ ...frame, ...text, paddingHorizontal: 10 }}
          />
        </View>
      ) : null}

      {draft.generate ? (
        <View
          style={{
            ...valueFrame,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingLeft: 10,
            paddingRight: 4,
          }}
        >
          <Icon name="sparkles" size={14} color={c.accent} />
          <Text accessibilityLiveRegion="polite" style={{ ...text, flex: 1 }}>
            {messages.generated}
          </Text>
          <Button label={messages.undo} variant="ghost" disabled={disabled} onPress={undo} />
        </View>
      ) : (
        <View
          style={{ ...valueFrame, flexDirection: "row", alignItems: "center", paddingLeft: 10 }}
        >
          <Icon name="lock" size={14} color={c["fg-subtle"]} />
          <TextInput
            ref={input}
            testID={`secret-input-${question.id}`}
            accessibilityLabel={question.label ?? question.prompt}
            accessibilityHint={spec?.looksLike ? messages.looksLike(spec.looksLike) : undefined}
            editable={!disabled}
            secureTextEntry={!revealed}
            textContentType={traits.textContentType}
            autoComplete={traits.autoComplete}
            importantForAutofill={traits.importantForAutofill}
            keyboardType={traits.keyboardType}
            passwordRules={traits.passwordRules}
            autoCorrect={traits.autoCorrect}
            autoCapitalize={traits.autoCapitalize}
            spellCheck={traits.spellCheck}
            returnKeyType="done"
            onChangeText={change}
            placeholder={messages.placeholder[traits.mode]}
            placeholderTextColor={c["fg-subtle"]}
            style={{ ...text, flex: 1, minHeight: 42, paddingHorizontal: 8 }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={revealed ? messages.hide : messages.show}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => setRevealed((value) => !value)}
            style={({ pressed }) => ({
              width: 44,
              height: 42,
              alignItems: "center",
              justifyContent: "center",
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Icon name={revealed ? "eye-off" : "eye"} size={16} color={c["fg-muted"]} />
          </Pressable>
        </View>
      )}

      {error ? (
        <Text accessibilityRole="alert" style={{ ...note, color: c["status-failed"] }}>
          {error}
        </Text>
      ) : null}

      {spec?.looksLike || mismatch || (spec?.allowGenerate && !draft.generate) ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1, gap: 2 }}>
            {spec?.looksLike && !draft.generate ? (
              <Text style={{ ...note, color: c["fg-subtle"] }}>
                {messages.looksLike(spec.looksLike)}
              </Text>
            ) : null}
            {mismatch && !draft.generate ? (
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
                <View style={{ paddingTop: 1 }}>
                  <Icon name="triangle-alert" size={12} color={c["status-waiting"]} />
                </View>
                <Text style={{ ...note, flex: 1, color: c["status-waiting"] }}>
                  {messages.patternWarning}
                </Text>
              </View>
            ) : null}
          </View>
          {spec?.allowGenerate && !draft.generate ? (
            <Button
              icon="sparkles"
              label={messages.generate}
              size="form"
              disabled={disabled}
              onPress={generate}
            />
          ) : null}
        </View>
      ) : null}

      <View style={{ gap: 2 }}>
        <Text style={label}>{messages.saveTo}</Text>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={messages.saveTo}
          style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 16 }}
        >
          {SECRET_SAVE_TO_OPTIONS.map((option: HumanInputSecretSaveTo) => {
            const selected = draft.saveTo === option;
            return (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityLabel={messages.saveToOption[option]}
                accessibilityState={{ checked: selected, disabled }}
                disabled={disabled}
                onPress={() => onDraft((current) => ({ ...current, saveTo: option }))}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }}
              >
                <View style={{ marginTop: -2 }}>
                  <Selector multi={false} selected={selected} />
                </View>
                <Text style={label}>{messages.saveToOption[option]}</Text>
              </Pressable>
            );
          })}
        </View>
        {spec?.vault && draft.saveTo === defaultSaveTo ? (
          <Text style={{ ...note, color: c["fg-subtle"] }}>{messages.vaultHint(spec.vault)}</Text>
        ) : null}
      </View>
    </View>
  );
}
