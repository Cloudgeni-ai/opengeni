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
import { disabled, font, foregroundStyle, tint } from "@expo/ui/swift-ui/modifiers";
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

function Row({ row }: { row: SettingsRow }) {
  switch (row.kind) {
    case "choice":
      return (
        <Button onPress={row.onPress}>
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
          modifiers={row.disabled ? [disabled(true)] : []}
        >
          <TwoLine title={row.title} subtitle={row.subtitle} />
        </Toggle>
      );
    case "info":
      return (
        <LabeledContent label={row.title}>
          <Text modifiers={[secondary]}>{row.value}</Text>
        </LabeledContent>
      );
    case "destructive":
      return (
        <Button
          role="destructive"
          onPress={row.onPress}
          label={row.title}
          {...(row.symbol ? { systemImage: row.symbol } : {})}
        />
      );
    default:
      return (
        <Button onPress={row.onPress}>
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
  return (
    <Host style={{ flex: 1 }} colorScheme={scheme === "dark" ? "dark" : "light"}>
      <Form modifiers={[tint("primary")]}>
        {sections.map((section) => (
          <Section
            key={section.id}
            {...(section.title ? { title: section.title } : {})}
            {...(section.footer ? { footer: <Text>{section.footer}</Text> } : {})}
          >
            {section.rows.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </Section>
        ))}
      </Form>
    </Host>
  );
}
