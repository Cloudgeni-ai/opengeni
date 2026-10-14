import {
  Button,
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
  listRowBackground,
  scrollContentBackground,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { useColorScheme } from "react-native";
import type { SettingsRow, SettingsSection } from "@/settings-model";

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

function Row({ row, rowBackground }: { row: SettingsRow; rowBackground: Modifier }) {
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

/** The settings model as a native inset-grouped SwiftUI Form. */
export function SettingsList({ sections }: { sections: SettingsSection[] }) {
  const scheme = useColorScheme();
  const theme = useNativeTimelineTheme();
  // The app's own canvas and card colors (as on the sessions screen and web),
  // not the system grouped black/grey, so Settings reads as the same app.
  const c = theme.colors;
  // Light mode's canvas is the same white as surface-1; rows step to surface-2.
  const row = listRowBackground(String(c["surface-1"] !== c.bg ? c["surface-1"] : c["surface-2"]));
  return (
    <Host style={{ flex: 1 }} colorScheme={scheme === "dark" ? "dark" : "light"}>
      <Form
        modifiers={[
          tint("primary"),
          scrollContentBackground("hidden"),
          background(String(theme.colors.bg)),
        ]}
      >
        {sections.map((section) => (
          <Section
            key={section.id}
            {...(section.title ? { title: section.title } : {})}
            {...(section.footer ? { footer: <Text>{section.footer}</Text> } : {})}
          >
            {section.rows.map((item) => (
              <Row key={item.id} row={item} rowBackground={row} />
            ))}
          </Section>
        ))}
      </Form>
    </Host>
  );
}
