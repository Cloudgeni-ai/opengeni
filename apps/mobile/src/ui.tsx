import {
  fontStyle,
  Icon,
  useNativeTimelineTheme,
  type NativeIconName,
} from "@opengeni/react-native/timeline";
import { Text, View } from "react-native";

/** A tile with a name's initial (or a glyph), like the web switcher's tiles. */
export function InitialTile({
  label,
  icon,
  size = 28,
  tone = "neutral",
}: {
  label?: string;
  icon?: NativeIconName;
  size?: number;
  tone?: "neutral" | "accent";
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 4),
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tone === "accent" ? c.primary : c["surface-3"],
      }}
    >
      {icon ? (
        <Icon
          name={icon}
          size={Math.round(size / 2)}
          color={tone === "accent" ? c["primary-fg"] : c["fg-muted"]}
        />
      ) : (
        <Text
          style={{
            ...fontStyle(theme, 600),
            fontSize: Math.round(size * 0.46),
            color: tone === "accent" ? c["primary-fg"] : c["fg-muted"],
          }}
        >
          {(label?.trim()[0] ?? "?").toUpperCase()}
        </Text>
      )}
    </View>
  );
}
