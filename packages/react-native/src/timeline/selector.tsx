import { View } from "react-native";
import { Icon } from "./icon";
import { useNativeTimelineTheme } from "./theme";

/** The question form's radio (single) or checkbox (multi) mark. */
export function Selector({ multi, selected }: { multi: boolean; selected: boolean }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View
      style={{
        marginTop: 2,
        width: 14,
        height: 14,
        borderRadius: multi ? 3 : 7,
        borderWidth: 1,
        borderColor: selected ? c.accent : c["fg-muted"],
        backgroundColor: selected && multi ? c.accent : c["surface-1"],
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {selected ? (
        multi ? (
          <Icon name="check" size={10} color={c["accent-fg"]} strokeWidth={3} />
        ) : (
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.accent }} />
        )
      ) : null}
    </View>
  );
}
