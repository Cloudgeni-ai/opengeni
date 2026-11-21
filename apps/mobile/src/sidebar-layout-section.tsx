import { SIDEBAR_ITEM_ICONS } from "@opengeni/contracts/sidebar-layout";
import {
  fontStyle,
  Icon,
  type NativeIconName,
  SessionAvatar,
  type SessionAvatarClient,
  useNativeTimelineTheme,
} from "@opengeni/react-native/timeline";
import { Linking, Pressable, Text, View } from "react-native";
import type { SidebarMenuRow, SidebarMenuSection } from "@/sidebar-layout";

// Every sidebar item icon is drawn natively (scripts/generate-native-icons.ts).
SIDEBAR_ITEM_ICONS satisfies readonly NativeIconName[];

/*
 * The workspace's sidebar links in the side menu, as the web rail shows them
 * above the chats: apps (optionally at one of their pages), outside links
 * (opened in the browser, marked with an arrow), agents (with their avatar,
 * opened on the web) and live lists of apps.
 */
export function SidebarLayoutSection(props: {
  sections: readonly SidebarMenuSection[];
  workspaceId: string;
  client?: SessionAvatarClient | null;
  onOpenApp: (row: Extract<SidebarMenuRow, { kind: "app" }>) => void;
  onOpenAgent: (row: Extract<SidebarMenuRow, { kind: "agent" }>) => void;
}) {
  if (!props.sections.length) return null;
  return (
    <View accessibilityLabel="Workspace links" style={{ marginBottom: 4 }}>
      {props.sections.map((section) => (
        <View key={section.key} style={{ marginTop: section.heading ? 12 : 0 }}>
          {section.heading ? <Heading label={section.heading} icon={section.icon} /> : null}
          {section.rows.map((row) => (
            <Row
              key={row.key}
              row={row}
              workspaceId={props.workspaceId}
              client={props.client}
              onPress={() => {
                if (row.kind === "app") props.onOpenApp(row);
                else if (row.kind === "agent") props.onOpenAgent(row);
                else void Linking.openURL(row.url).catch(() => undefined);
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function Heading({ label, icon }: { label: string; icon?: NativeIconName | undefined }) {
  const theme = useNativeTimelineTheme();
  const text = (
    <Text
      accessibilityRole="header"
      numberOfLines={1}
      style={{
        ...fontStyle(theme, 600),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors["fg-muted"],
        paddingHorizontal: 4,
        marginBottom: 2,
      }}
    >
      {label}
    </Text>
  );
  if (!icon) return text;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 4 }}>
      <Icon name={icon} size={12} color={theme.colors["fg-muted"]} />
      {text}
    </View>
  );
}

function Row({
  row,
  workspaceId,
  client,
  onPress,
}: {
  row: SidebarMenuRow;
  workspaceId: string;
  client?: SessionAvatarClient | null | undefined;
  onPress: () => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const external = row.kind === "link" || row.kind === "agent";
  return (
    <Pressable
      accessibilityRole={external ? "link" : "button"}
      accessibilityLabel={row.label}
      accessibilityHint={external ? "Opens in the browser" : undefined}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 40,
        paddingVertical: 8,
        paddingHorizontal: 8,
        borderRadius: theme.radius.md,
        backgroundColor: pressed ? c.hover : "transparent",
      })}
    >
      {row.kind === "agent" ? (
        <SessionAvatar
          avatar={row.avatar}
          name={row.label}
          workspaceId={workspaceId}
          seed={row.agentId}
          size="xs"
          client={client}
        />
      ) : (
        <Icon
          name={row.icon ?? (row.kind === "link" ? "arrow-up-right" : "app-window")}
          size={16}
          color={c["fg-muted"]}
        />
      )}
      <Text
        numberOfLines={1}
        style={{ ...fontStyle(theme, 500), flex: 1, fontSize: 15, color: c.fg }}
      >
        {row.label}
      </Text>
    </Pressable>
  );
}
