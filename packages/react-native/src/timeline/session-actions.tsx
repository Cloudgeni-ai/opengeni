import type { Session, UpdateSessionPinRequest, UpdateSessionRequest } from "@opengeni/sdk";
import {
  resolveRenameSubmission,
  SESSION_TITLE_MAX_LENGTH,
  sessionDisplayTitle,
  sessionRenameSeed,
} from "@opengeni/react/session-list-model";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Button } from "./controls";
import { Icon, type NativeIconName } from "./icon";
import { BottomSheet } from "./sheet";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   The web session header's Rename and Pin, behind one native overflow button:
   an action sheet, then a rename sheet that seeds and resolves exactly as the
   web title editor does (shared session-list model).
   -------------------------------------------------------------------------- */

export interface SessionActionsClient {
  updateSession(
    workspaceId: string,
    sessionId: string,
    request: UpdateSessionRequest,
  ): Promise<Session>;
  updateSessionPin(
    workspaceId: string,
    sessionId: string,
    request: UpdateSessionPinRequest,
  ): Promise<Session>;
}

export interface SessionActionsProps {
  session: Session;
  client: SessionActionsClient;
  /** Called with the server's session after a change, so the host can refresh. */
  onChanged: (session: Session) => void;
  /** Host actions appended after Rename and Pin. */
  extraActions?: SessionAction[] | undefined;
  onActionFeedback?: (() => void) | undefined;
}

export interface SessionAction {
  key: string;
  label: string;
  icon: NativeIconName;
  onPress: () => void;
  destructive?: boolean | undefined;
}

export function SessionActionsButton(props: SessionActionsProps) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The pin flips immediately on this device and rolls back on failure, as on web.
  const [pinnedOverride, setPinnedOverride] = useState<boolean | null>(null);
  const pinned = pinnedOverride ?? props.session.pinned ?? false;
  useEffect(() => setPinnedOverride(null), [props.session.pinned, props.session.pinVersion]);

  const togglePin = async () => {
    const next = !pinned;
    setPinnedOverride(next);
    setError(null);
    props.onActionFeedback?.();
    try {
      const updated = await props.client.updateSessionPin(
        props.session.workspaceId,
        props.session.id,
        {
          pinned: next,
          ...(props.session.pinVersion !== undefined
            ? { expectedVersion: props.session.pinVersion }
            : {}),
        },
      );
      props.onChanged(updated);
    } catch (caught) {
      setPinnedOverride(null);
      setError(
        `Couldn't ${next ? "pin" : "unpin"} this chat. ${caught instanceof Error ? caught.message : ""}`.trim(),
      );
      setMenuOpen(true);
    }
  };

  const actions: SessionAction[] = [
    {
      key: "rename",
      label: "Rename",
      icon: "pencil",
      onPress: () => {
        setMenuOpen(false);
        // Let the action sheet finish dismissing before presenting the next one.
        setTimeout(() => setRenaming(true), 350);
      },
    },
    {
      key: "pin",
      label: pinned ? "Unpin" : "Pin",
      icon: pinned ? "pin-off" : "pin",
      onPress: () => {
        setMenuOpen(false);
        void togglePin();
      },
    },
    ...(props.extraActions ?? []).map((action) => ({
      ...action,
      onPress: () => {
        setMenuOpen(false);
        action.onPress();
      },
    })),
  ];

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Chat actions"
        hitSlop={6}
        onPress={() => setMenuOpen(true)}
        style={({ pressed }) => ({
          width: 36,
          height: 36,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 18,
          backgroundColor: pressed ? c.hover : "transparent",
        })}
      >
        {pinned ? (
          <View
            style={{
              position: "absolute",
              top: 5,
              right: 5,
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: c["fg-muted"],
            }}
          />
        ) : null}
        <Icon name="ellipsis" size={20} color={c.fg} />
      </Pressable>
      <BottomSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        accessibilityLabel="Chat actions"
      >
        <Text
          numberOfLines={1}
          style={{
            ...fontStyle(theme, 600),
            fontSize: 15,
            color: c.fg,
            paddingHorizontal: 20,
            paddingBottom: 8,
          }}
        >
          {sessionDisplayTitle(props.session)}
        </Text>
        {error ? (
          <Text
            accessibilityRole="alert"
            style={{
              ...fontStyle(theme),
              fontSize: 13,
              color: c["status-failed"],
              paddingHorizontal: 20,
              paddingBottom: 6,
            }}
          >
            {error}
          </Text>
        ) : null}
        {actions.map((action) => (
          <Pressable
            key={action.key}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            onPress={action.onPress}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 14,
              minHeight: 52,
              paddingHorizontal: 20,
              backgroundColor: pressed ? c.hover : "transparent",
            })}
          >
            <Icon
              name={action.icon}
              size={18}
              color={action.destructive ? c["status-failed"] : c["fg-muted"]}
            />
            <Text
              style={{
                ...fontStyle(theme),
                fontSize: 16,
                color: action.destructive ? c["status-failed"] : c.fg,
              }}
            >
              {action.label}
            </Text>
          </Pressable>
        ))}
      </BottomSheet>
      <RenameSheet
        open={renaming}
        session={props.session}
        client={props.client}
        onClose={() => setRenaming(false)}
        onRenamed={(session) => {
          setRenaming(false);
          props.onActionFeedback?.();
          props.onChanged(session);
        }}
      />
    </>
  );
}

function RenameSheet(props: {
  open: boolean;
  session: Session;
  client: SessionActionsClient;
  onClose: () => void;
  onRenamed: (session: Session) => void;
}) {
  // Each opening mounts a fresh form seeded before its first render, so the
  // focused field selects the whole seed and typing replaces it.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (props.open) setGeneration((value) => value + 1);
  }, [props.open]);
  return (
    <BottomSheet open={props.open} onClose={props.onClose} accessibilityLabel="Rename chat">
      <RenameForm key={generation} {...props} />
    </BottomSheet>
  );
}

function RenameForm(props: {
  session: Session;
  client: SessionActionsClient;
  onClose: () => void;
  onRenamed: (session: Session) => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [seed] = useState(() => sessionRenameSeed(props.session));
  const [draft, setDraft] = useState(seed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const inputRef = useRef<TextInput>(null);
  const save = async () => {
    if (inFlight.current) return;
    const next = resolveRenameSubmission(draft, sessionDisplayTitle(props.session), seed);
    if (next === null) {
      props.onClose();
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const updated = await props.client.updateSession(
        props.session.workspaceId,
        props.session.id,
        { title: next },
      );
      props.onRenamed(updated);
    } catch (caught) {
      setError(
        `Couldn't rename this chat. ${caught instanceof Error ? caught.message : "Try again."}`,
      );
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  return (
    <View style={{ paddingHorizontal: 20, gap: 12 }}>
      <Text
        accessibilityRole="header"
        style={{ ...fontStyle(theme, 600), fontSize: 17, color: c.fg }}
      >
        Rename chat
      </Text>
      <TextInput
        accessibilityLabel="Chat title"
        value={draft}
        onChangeText={setDraft}
        ref={inputRef}
        onFocus={() => {
          // selectTextOnFocus is unreliable for autofocused fields in a modal.
          setTimeout(() => inputRef.current?.setSelection(0, seed.length), 50);
        }}
        maxLength={SESSION_TITLE_MAX_LENGTH}
        autoFocus
        editable={!saving}
        returnKeyType="done"
        onSubmitEditing={() => void save()}
        style={{
          ...fontStyle(theme),
          fontSize: 16,
          color: c.fg,
          minHeight: 44,
          paddingHorizontal: 12,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c["surface-1"],
        }}
      />
      {error ? (
        <Text
          accessibilityRole="alert"
          style={{ ...fontStyle(theme), fontSize: 13, color: c["status-failed"] }}
        >
          {error}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        <Button label="Cancel" variant="ghost" onPress={props.onClose} disabled={saving} />
        <Button
          label={saving ? "Saving…" : "Save"}
          variant="primary"
          onPress={() => void save()}
          disabled={saving}
          busy={saving}
        />
      </View>
    </View>
  );
}
