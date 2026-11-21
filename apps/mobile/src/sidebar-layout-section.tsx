import { fontStyle, Icon, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { Linking, Pressable, Text, View } from "react-native";
import type { SidebarMenuRow, SidebarMenuSection } from "@/sidebar-layout";

/*
 * The workspace's sidebar links in the side menu, as the web rail shows them
 * above the chats: apps (optionally at one of their pages), outside links
 * (opened in the browser, marked with an arrow) and live lists of apps.
 */
export function SidebarLayoutSection(props: {
  sections: readonly SidebarMenuSection[];
  onOpenApp: (row: Extract<SidebarMenuRow, { kind: "app" }>) => void;
}) {
  if (!props.sections.length) return null;
  return (
    <View accessibilityLabel="Workspace links" style={{ marginBottom: 4 }}>
      {props.sections.map((section) => (
        <View key={section.key} style={{ marginTop: section.heading ? 12 : 0 }}>
          {section.heading ? <Heading label={section.heading} /> : null}
          {section.rows.map((row) => (
            <Row
              key={row.key}
              row={row}
              onPress={() => {
                if (row.kind === "app") props.onOpenApp(row);
                else void Linking.openURL(row.url).catch(() => undefined);
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function Heading({ label }: { label: string }) {
  const theme = useNativeTimelineTheme();
  return (
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
}

function Row({ row, onPress }: { row: SidebarMenuRow; onPress: () => void }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const external = row.kind === "link";
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
      <Icon name={external ? "arrow-up-right" : "app-window"} size={16} color={c["fg-muted"]} />
      <Text
        numberOfLines={1}
        style={{ ...fontStyle(theme, 500), flex: 1, fontSize: 15, color: c.fg }}
      >
        {row.label}
      </Text>
    </Pressable>
  );
}
