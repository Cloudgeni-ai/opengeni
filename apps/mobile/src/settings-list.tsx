import { Host, LazyColumn, ListItem, RadioButton, Switch, Text } from "@expo/ui/jetpack-compose";
import { clickable, padding } from "@expo/ui/jetpack-compose/modifiers";
import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { useColorScheme } from "react-native";
import type { SettingsRow, SettingsSection } from "@/settings-model";

function Row({ row, danger }: { row: SettingsRow; danger: string }) {
  const onPress =
    row.kind === "toggle"
      ? () => {
          if (!row.disabled) row.onChange(!row.value);
        }
      : row.kind === "info"
        ? undefined
        : row.onPress;
  const subtitle = row.kind === "info" ? row.value : row.subtitle;
  return (
    <ListItem {...(onPress ? { modifiers: [clickable(onPress)] } : {})}>
      <ListItem.HeadlineContent>
        <Text {...(row.kind === "destructive" ? { color: danger } : {})}>{row.title}</Text>
      </ListItem.HeadlineContent>
      {subtitle ? (
        <ListItem.SupportingContent>
          <Text>{row.kind === "external" ? `${subtitle} · Opens on the web` : subtitle}</Text>
        </ListItem.SupportingContent>
      ) : row.kind === "external" ? (
        <ListItem.SupportingContent>
          <Text>Opens on the web</Text>
        </ListItem.SupportingContent>
      ) : null}
      {row.kind === "choice" ? (
        <ListItem.TrailingContent>
          <RadioButton selected={row.selected} onClick={row.onPress} />
        </ListItem.TrailingContent>
      ) : row.kind === "toggle" ? (
        <ListItem.TrailingContent>
          <Switch value={row.value} onCheckedChange={row.onChange} enabled={!row.disabled} />
        </ListItem.TrailingContent>
      ) : null}
    </ListItem>
  );
}

/** The settings model as Material 3 list items with section headers. */
export function SettingsList({ sections }: { sections: SettingsSection[] }) {
  const scheme = useColorScheme();
  const theme = useNativeTimelineTheme();
  return (
    <Host style={{ flex: 1 }} colorScheme={scheme === "dark" ? "dark" : "light"}>
      <LazyColumn contentPadding={{ bottom: 24 }}>
        {sections.flatMap((section) => [
          section.title ? (
            <Text
              key={`${section.id}:title`}
              style={{ typography: "titleSmall" }}
              color={String(theme.colors["fg-muted"])}
              modifiers={[padding(16, 20, 16, 4)]}
            >
              {section.title}
            </Text>
          ) : null,
          ...section.rows.map((row) => (
            <Row
              key={`${section.id}:${row.id}`}
              row={row}
              danger={String(theme.colors["status-failed"])}
            />
          )),
          section.footer ? (
            <Text
              key={`${section.id}:footer`}
              style={{ typography: "bodySmall" }}
              color={String(theme.colors["fg-subtle"])}
              modifiers={[padding(16, 4, 16, 8)]}
            >
              {section.footer}
            </Text>
          ) : null,
        ])}
      </LazyColumn>
    </Host>
  );
}
