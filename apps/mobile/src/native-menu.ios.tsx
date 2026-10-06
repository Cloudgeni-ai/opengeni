import type { MenuAction, MenuComponentProps } from "@expo/ui/community/menu";
import { Button, Host, Menu, RNHostView, Section, Toggle } from "@expo/ui/swift-ui";
import { disabled as disabledModifier } from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { useColorScheme } from "react-native";

export type { MenuAction } from "@expo/ui/community/menu";

function actionId(action: MenuAction): string {
  return action.id ?? action.title;
}

function renderAction(
  action: MenuAction,
  onPressAction: MenuComponentProps["onPressAction"],
): ReactNode {
  if (action.attributes?.hidden) return null;
  const key = actionId(action);
  const systemImage = typeof action.image === "string" ? action.image : undefined;
  const fire = () => onPressAction?.({ nativeEvent: { event: key } });
  if (action.subactions && action.subactions.length > 0) {
    const children = action.subactions.map((sub) => renderAction(sub, onPressAction));
    return action.displayInline ? (
      <Section key={key} title={action.title}>
        {children}
      </Section>
    ) : (
      <Menu key={key} label={action.title} systemImage={systemImage}>
        {children}
      </Menu>
    );
  }
  const modifiers = action.attributes?.disabled ? [disabledModifier(true)] : undefined;
  if (action.state === "on" || action.state === "off") {
    return (
      <Toggle
        key={key}
        label={action.title}
        systemImage={systemImage}
        isOn={action.state === "on"}
        onIsOnChange={fire}
        modifiers={modifiers}
      />
    );
  }
  return (
    <Button
      key={key}
      label={action.title}
      systemImage={systemImage}
      role={action.attributes?.destructive ? "destructive" : undefined}
      modifiers={modifiers}
      onPress={fire}
    />
  );
}

/**
 * A SwiftUI menu that follows the app's light or dark appearance. (The
 * community MenuView accepts a color scheme but never hands it to its SwiftUI
 * host, so its menus always render light.)
 */
export function NativeMenu(props: {
  actions: MenuAction[];
  onPressAction?: MenuComponentProps["onPressAction"];
  children: ReactNode;
}) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  return (
    <Host matchContents colorScheme={scheme} ignoreSafeArea="all">
      <Menu
        label={
          <RNHostView matchContents>
            <>{props.children}</>
          </RNHostView>
        }
      >
        {props.actions.map((action) => renderAction(action, props.onPressAction))}
      </Menu>
    </Host>
  );
}
