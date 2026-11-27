import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Keyboard, Modal, Platform, StyleSheet, useWindowDimensions } from "react-native";
import { FullWindowOverlay } from "react-native-screens";

export type CallSurfaceLayerProps = {
  /** Whether the call fills the screen; false slides it away and then unmounts it. */
  visible: boolean;
  /** Android Back while the surface is up; the call minimizes. */
  onRequestClose(): void;
  children: ReactNode;
};

/**
 * The full-screen call surface, above everything else in the app.
 *
 * On iOS it is a layer in the window, not a presented modal. A presented modal (React
 * Native's `Modal`) competes with the app navigator's own native modal screens for the
 * root view controller's one presentation: started while a native modal screen is up,
 * its presentation waits until that screen is dismissed; a minimize in that window
 * dismisses nothing, and the late presentation then lands with no content, a blank
 * screen over the whole app that takes every touch. The navigator also dismisses
 * modals it does not own when its own modals change. The window layer has no
 * presentation that can fall out of step: it is mounted above every presented screen
 * when it opens, and hidden means unmounted, so whatever is underneath shows.
 *
 * On Android a `Modal` is its own dialog window, shown and removed directly, so it stays
 * the surface there: it covers other dialog windows such as sheets, keeps TalkBack in
 * the call, and Back minimizes.
 */
export function CallSurfaceLayer(props: CallSurfaceLayerProps) {
  if (Platform.OS === "ios") return <WindowLayer {...props} />;
  return (
    <Modal visible={props.visible} animationType="slide" onRequestClose={props.onRequestClose}>
      {props.children}
    </Modal>
  );
}

function WindowLayer(props: CallSurfaceLayerProps) {
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(props.visible);
  const shown = useRef(new Animated.Value(0)).current;
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

  if (!mounted) return null;
  return (
    <FullWindowOverlay unstable_accessibilityContainerViewIsModal>
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
    </FullWindowOverlay>
  );
}
