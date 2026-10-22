import { MenuView, type MenuAction, type MenuComponentProps } from "@expo/ui/community/menu";
import type { ReactNode } from "react";
import { useColorScheme } from "react-native";

export type { MenuAction } from "@expo/ui/community/menu";

/** A native menu (a Material dropdown on Android) that follows the app's appearance. */
export function NativeMenu(props: {
  actions: MenuAction[];
  onPressAction?: MenuComponentProps["onPressAction"];
  children: ReactNode;
}) {
  const scheme = useColorScheme();
  return (
    <MenuView actions={props.actions} colorScheme={scheme} onPressAction={props.onPressAction}>
      {props.children}
    </MenuView>
  );
}
