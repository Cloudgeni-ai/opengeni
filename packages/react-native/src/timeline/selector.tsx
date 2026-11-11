import { View } from "react-native";
import { Icon } from "./icon";
import { useNativeTimelineTheme } from "./theme";

/** The question form's radio (single) or checkbox (multi) mark, as on web: solid when chosen. */
export function Selector({ multi, selected }: { multi: boolean; selected: boolean }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View
      style={{
        marginTop: 1,
        width: 18,
        height: 18,
        borderRadius: multi ? 5 : 9,
        borderWidth: 1,
        borderColor: selected ? c.fg : c["border-strong"],
        backgroundColor: selected ? c.fg : c["surface-1"],
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {selected ? (
        multi ? (
          <Icon name="check" size={12} color={c.bg} strokeWidth={3} />
        ) : (
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.bg }} />
        )
      ) : null}
    </View>
  );
}
