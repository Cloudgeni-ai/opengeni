import {
  Button,
  ContentUnavailableView,
  Form,
  HStack,
  Host,
  Image,
  Label,
  LabeledContent,
  Section,
  Spacer,
  Text,
  Toggle,
  VStack,
} from "@expo/ui/swift-ui";
import {
  background,
  disabled,
  font,
  foregroundStyle,
  lineLimit,
  listRowBackground,
  onTapGesture,
  refreshable,
  scrollContentBackground,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { useState } from "react";
import { useColorScheme } from "react-native";
import type { SettingsEmpty, SettingsRow, SettingsSection } from "@/settings-model";

const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });
const primary = foregroundStyle({ type: "hierarchical", style: "primary" });

function TwoLine({ title, subtitle }: { title: string; subtitle?: string | undefined }) {
  return (
    <VStack alignment="leading" spacing={2}>
      <Text modifiers={[primary]}>{title}</Text>
      {subtitle ? (
        <Text modifiers={[font({ textStyle: "footnote" }), secondary]}>{subtitle}</Text>
      ) : null}
    </VStack>
  );
}

type Modifier = ReturnType<typeof listRowBackground>;

/** A paragraph folded to a few lines; a tap shows the rest, another folds it again. */
function FoldedText({
  text,
  lines,
  rowBackground,
}: {
  text: string;
  lines: number;
  rowBackground: Modifier;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Text
      modifiers={[
        primary,
        ...(open ? [] : [lineLimit(lines)]),
        onTapGesture(() => setOpen((was) => !was)),
        rowBackground,
      ]}
    >
      {text}
    </Text>
  );
}

function Row({
  row,
  rowBackground,
  danger,
}: {
  row: SettingsRow;
  rowBackground: Modifier;
  danger: string;
}) {
  switch (row.kind) {
    case "choice":
      return (
        <Button onPress={row.onPress} modifiers={[rowBackground]}>
          <HStack>
            <TwoLine title={row.title} subtitle={row.subtitle} />
            <Spacer />
            {row.selected ? <Image systemName="checkmark" modifiers={[primary]} /> : null}
          </HStack>
        </Button>
      );
    case "toggle":
      return (
        <Toggle
          isOn={row.value}
          onIsOnChange={row.onChange}
          modifiers={row.disabled ? [disabled(true), rowBackground] : [rowBackground]}
        >
          <TwoLine title={row.title} subtitle={row.subtitle} />
        </Toggle>
      );
    case "info":
      return (
        <LabeledContent label={row.title} modifiers={[rowBackground]}>
          <Text modifiers={[secondary]}>{row.value}</Text>
        </LabeledContent>
      );
    case "text":
      return <FoldedText text={row.text} lines={row.lines ?? 4} rowBackground={rowBackground} />;
    case "navigate": {
      const content = (
        <HStack spacing={8} {...(row.onPress ? {} : { modifiers: [rowBackground] })}>
          <TwoLine title={row.title} subtitle={row.subtitle} />
          <Spacer />
          {row.detail ? (
            <Text
              modifiers={[
                font({ textStyle: "subheadline" }),
                row.detailTone === "danger" ? foregroundStyle(danger) : secondary,
              ]}
            >
              {row.detail}
            </Text>
          ) : null}
          {row.onPress ? (
            <Image systemName="chevron.right" size={13} modifiers={[secondary]} />
          ) : null}
        </HStack>
      );
      return row.onPress ? (
        <Button onPress={row.onPress} modifiers={[rowBackground]}>
          {content}
        </Button>
      ) : (
        content
      );
    }
    case "destructive":
      return (
        <Button
          role="destructive"
          onPress={row.onPress}
          modifiers={[rowBackground]}
          label={row.title}
          {...(row.symbol ? { systemImage: row.symbol } : {})}
        />
      );
    default:
      return (
        <Button onPress={row.onPress} modifiers={[rowBackground]}>
          <HStack>
            {row.symbol ? (
              <Label systemImage={row.symbol}>
                <TwoLine title={row.title} subtitle={row.subtitle} />
              </Label>
            ) : (
              <TwoLine title={row.title} subtitle={row.subtitle} />
            )}
            <Spacer />
            {row.kind === "external" ? (
              <Image systemName="arrow.up.right" size={13} modifiers={[secondary]} />
            ) : null}
          </HStack>
        </Button>
      );
  }
}

/**
 * The settings model as a native inset-grouped SwiftUI Form. With `onRefresh`
 * the list refreshes on a pull; with `empty` and no sections it shows the
 * system's empty view instead.
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
  // The app's own canvas and card colors (as on the sessions screen and web),
  // not the system grouped black/grey, so Settings reads as the same app.
  const c = theme.colors;
  // Light mode's canvas is the same white as surface-1; rows step to surface-2.
  const row = listRowBackground(String(c["surface-1"] !== c.bg ? c["surface-1"] : c["surface-2"]));
  const danger = String(c["status-failed"]);
  if (empty && sections.length === 0) {
    return (
      <Host style={{ flex: 1 }} colorScheme={scheme === "dark" ? "dark" : "light"}>
        <ContentUnavailableView
          title={empty.title}
          {...(empty.symbol ? { systemImage: empty.symbol } : {})}
          {...(empty.description ? { description: empty.description } : {})}
          modifiers={[background(String(c.bg))]}
        />
      </Host>
    );
  }
  return (
    <Host style={{ flex: 1 }} colorScheme={scheme === "dark" ? "dark" : "light"}>
      <Form
        modifiers={[
          tint("primary"),
          scrollContentBackground("hidden"),
          background(String(theme.colors.bg)),
          ...(onRefresh ? [refreshable(onRefresh)] : []),
        ]}
      >
        {sections.map((section) => (
          <Section
            key={section.id}
            {...(section.title ? { title: section.title } : {})}
            {...(section.footer ? { footer: <Text>{section.footer}</Text> } : {})}
          >
            {section.rows.map((item) => (
              <Row key={item.id} row={item} rowBackground={row} danger={danger} />
            ))}
          </Section>
        ))}
      </Form>
    </Host>
  );
}
