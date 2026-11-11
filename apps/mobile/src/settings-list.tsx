import {
  Column,
  Host,
  LazyColumn,
  ListItem,
  PullToRefreshBox,
  RadioButton,
  Switch,
  Text,
} from "@expo/ui/jetpack-compose";
import { clickable, padding } from "@expo/ui/jetpack-compose/modifiers";
import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { useState } from "react";
import { useColorScheme } from "react-native";
import type { SettingsEmpty, SettingsRow, SettingsSection } from "@/settings-model";

/** A paragraph folded to a few lines; a tap shows the rest, another folds it again. */
function FoldedText({ text, lines }: { text: string; lines: number }) {
  const [open, setOpen] = useState(false);
  return (
    <ListItem modifiers={[clickable(() => setOpen((was) => !was))]}>
      <ListItem.HeadlineContent>
        <Text {...(open ? {} : { maxLines: lines, overflow: "ellipsis" as const })}>{text}</Text>
      </ListItem.HeadlineContent>
    </ListItem>
  );
}

function Row({ row, danger, muted }: { row: SettingsRow; danger: string; muted: string }) {
  if (row.kind === "text") return <FoldedText text={row.text} lines={row.lines ?? 4} />;
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
      ) : row.kind === "navigate" && row.detail ? (
        <ListItem.TrailingContent>
          <Text color={row.detailTone === "danger" ? danger : muted}>{row.detail}</Text>
        </ListItem.TrailingContent>
      ) : null}
    </ListItem>
  );
}

/**
 * The settings model as Material 3 list items with section headers. With
 * `onRefresh` the list refreshes on a pull; with `empty` and no sections it
 * says so instead.
 */
export function SettingsList({
  sections,
  onRefresh,
  empty,
}: {
  sections: SettingsSection[];
  onRefresh?: (() => Promise<void>) | undefined;
  empty?: SettingsEmpty | undefined;
}) {
  const scheme = useColorScheme();
  const theme = useNativeTimelineTheme();
  const [refreshing, setRefreshing] = useState(false);
  const muted = String(theme.colors["fg-muted"]);
  const list =
    empty && sections.length === 0 ? (
      <Column modifiers={[padding(24, 48, 24, 24)]}>
        <Text style={{ typography: "titleMedium" }}>{empty.title}</Text>
        {empty.description ? (
          <Text style={{ typography: "bodyMedium" }} color={muted}>
            {empty.description}
          </Text>
        ) : null}
      </Column>
    ) : (
      <LazyColumn contentPadding={{ bottom: 24 }}>
        {sections.flatMap((section) => [
          section.title ? (
            <Text
              key={`${section.id}:title`}
              style={{ typography: "titleSmall" }}
              color={muted}
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
              muted={muted}
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
    );
  return (
    <Host style={{ flex: 1 }} colorScheme={scheme === "dark" ? "dark" : "light"}>
      {onRefresh ? (
        <PullToRefreshBox
          isRefreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void onRefresh().finally(() => setRefreshing(false));
          }}
        >
          {list}
        </PullToRefreshBox>
      ) : (
        list
      )}
    </Host>
  );
}
