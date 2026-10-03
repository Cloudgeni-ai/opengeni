import type { Session } from "@opengeni/sdk";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";

export default function SessionsScreen() {
  const { client, workspaceId, workspaces, error, reload } = useAccount();
  const insets = useSafeAreaInsets();
  const headerHeight = insets.top + 44;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      setSessions(await client.listSessions(workspaceId, { limit: 50 }));
      setListError(null);
    } catch (caught) {
      setListError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const create = async () => {
    const text = draft.trim();
    if (!workspaceId || !text || creating) return;
    setCreating(true);
    try {
      const created = await client.createSession(workspaceId, {
        initialMessage: text,
        ...(process.env.EXPO_PUBLIC_OPENGENI_DEFAULT_MODEL
          ? { model: process.env.EXPO_PUBLIC_OPENGENI_DEFAULT_MODEL }
          : {}),
        ...(process.env.EXPO_PUBLIC_OPENGENI_DEFAULT_REASONING
          ? { reasoningEffort: process.env.EXPO_PUBLIC_OPENGENI_DEFAULT_REASONING as "low" }
          : {}),
      });
      setDraft("");
      router.push(`/session/${created.id}`);
    } catch (caught) {
      setListError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  };

  const workspaceName = workspaces.find((workspace) => workspace.id === workspaceId)?.name;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={headerHeight}
      style={styles.root}
    >
      {error || listError ? (
        <Text style={styles.error}>{error?.message ?? listError}</Text>
      ) : null}
      <FlatList
        data={sessions}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(session) => session.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void reload().then(load)} />}
        ListHeaderComponent={
          workspaceName ? <Text style={styles.workspace}>{workspaceName}</Text> : null
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/session/${item.id}`)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <Text numberOfLines={1} style={styles.rowTitle}>
              {item.title ?? "Untitled session"}
            </Text>
            <Text style={styles.rowMeta}>{item.status}</Text>
          </Pressable>
        )}
      />
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <TextInput
          accessibilityLabel="New session message"
          multiline
          onChangeText={setDraft}
          placeholder="Ask anything"
          style={styles.input}
          value={draft}
        />
        <Pressable
          accessibilityLabel="Start session"
          accessibilityRole="button"
          disabled={!draft.trim() || creating}
          onPress={() => void create()}
          style={[styles.send, (!draft.trim() || creating) && styles.sendDisabled]}
        >
          {creating ? <ActivityIndicator color="#fff" /> : <Text style={styles.sendText}>↑</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  error: { color: "#b42318", padding: 16 },
  workspace: { fontSize: 13, color: "#667085", paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  row: { paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#e4e7ec" },
  rowPressed: { backgroundColor: "#f2f4f7" },
  rowTitle: { fontSize: 16, color: "#101828" },
  rowMeta: { fontSize: 13, color: "#667085", marginTop: 2 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#e4e7ec" },
  input: { flex: 1, minHeight: 44, maxHeight: 140, borderRadius: 22, backgroundColor: "#f2f4f7", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12, fontSize: 16 },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: "#101828", alignItems: "center", justifyContent: "center" },
  sendDisabled: { opacity: 0.35 },
  sendText: { color: "#fff", fontSize: 20, fontWeight: "600" },
});