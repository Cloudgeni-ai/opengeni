import { useState } from "react";
import { Pressable, Text, View, type TextStyle } from "react-native";
import { useOpenGeniText } from "@opengeni/react/messages";
import { plainTextPage } from "./markdown-limit";
import { useReleaseFollow } from "./primitives";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/** Only one bounded page is mounted, even after reading the entire message. */
export function PlainTextMessage({ text, style }: { text: string; style: TextStyle }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const releaseFollow = useReleaseFollow();
  const [requestedPage, setPage] = useState(0);
  const page = plainTextPage(text, requestedPage);
  const controlStyle = {
    ...fontStyle(theme, 500),
    fontSize: theme.size.sm,
    color: theme.colors["accent-strong"],
  };
  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <Text style={{ ...controlStyle, color: theme.colors["fg-muted"], flex: 1 }}>
          {t("native.timeline.messages.plainTextPage", {
            page: page.index + 1,
            count: page.count,
          })}
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={page.index === 0}
          onPress={() => {
            releaseFollow();
            setPage(page.index - 1);
          }}
          style={{
            padding: 8,
            minHeight: 44,
            justifyContent: "center",
            opacity: page.index === 0 ? 0.4 : 1,
          }}
        >
          <Text style={controlStyle}>{t("native.timeline.messages.previousPage")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={page.index === page.count - 1}
          onPress={() => {
            releaseFollow();
            setPage(page.index + 1);
          }}
          style={{
            padding: 8,
            minHeight: 44,
            justifyContent: "center",
            opacity: page.index === page.count - 1 ? 0.4 : 1,
          }}
        >
          <Text style={controlStyle}>{t("native.timeline.messages.nextPage")}</Text>
        </Pressable>
      </View>
      <Text selectable style={style}>
        {page.text}
      </Text>
    </View>
  );
}
