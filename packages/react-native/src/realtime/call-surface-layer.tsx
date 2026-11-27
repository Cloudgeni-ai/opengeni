import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  BackHandler,
  Keyboard,
  Platform,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { FullWindowOverlay } from "react-native-screens";

export type CallSurfaceLayerProps = {
  /** Whether the call fills the screen; false slides it away and then unmounts it. */
  visible: boolean;
  /** Android Back while the surface is up; the call minimizes. */
  onRequestClose(): void;
  children: ReactNode;
};

/**
 * The full-screen call surface, drawn as a layer above the app instead of a presented
 * modal.
 *
 * A presented modal (React Native's `Modal`) competes with the app navigator's own
 * native modal screens for the one presentation slot of the root view controller.
 * Started while a native modal screen is up, its presentation waits until that screen
 * is dismissed; a minimize in that window dismisses nothing, and the late presentation
 * then lands with no content, a blank screen over the whole app that takes every touch.
 * The navigator also dismisses modals it does not own when its own modals change. A
 * layer has no presentation of its own that can fall out of step: hidden means
 * unmounted, so whatever is underneath shows.
 *
 * On iOS the layer is mounted in the window above every presented screen when it opens,
 * so it also covers native modal screens; on Android it is drawn above the app in place
 * and Back minimizes.
 */
export function CallSurfaceLayer(props: CallSurfaceLayerProps) {
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(props.visible);
  const shown = useRef(new Animated.Value(0)).current;
  const onRequestClose = useRef(props.onRequestClose);
  onRequestClose.current = props.onRequestClose;
  if (props.visible && !mounted) setMounted(true);

  useEffect(() => {
    if (!mounted) return;
    if (props.visible) Keyboard.dismiss();
    const animation = Animated.timing(shown, {
      toValue: props.visible ? 1 : 0,
      duration: props.visible ? 320 : 260,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !props.visible) setMounted(false);
    });
    return () => animation.stop();
  }, [mounted, props.visible, shown]);

  useEffect(() => {
    if (!props.visible) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onRequestClose.current();
      return true;
    });
    return () => subscription.remove();
  }, [props.visible]);

  if (!mounted) return null;
  const layer = (
    <Animated.View
      pointerEvents={props.visible ? "auto" : "none"}
      accessibilityViewIsModal
      style={[
        StyleSheet.absoluteFill,
        {
          transform: [
            { translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) },
          ],
        },
      ]}
    >
      {props.children}
    </Animated.View>
  );
  return Platform.OS === "ios" ? (
    <FullWindowOverlay unstable_accessibilityContainerViewIsModal>{layer}</FullWindowOverlay>
  ) : (
    layer
  );
}
