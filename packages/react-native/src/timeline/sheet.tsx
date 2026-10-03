import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNativeTimelineTheme } from "./theme";

/**
 * A content-sized bottom sheet: dimmed backdrop, grabber, drag or tap outside
 * to dismiss, keyboard-aware and safe-area padded. The native counterpart of
 * the web's anchored menus at phone width.
 */
export function BottomSheet(props: {
  open: boolean;
  onClose: () => void;
  accessibilityLabel: string;
  /** Cap as a fraction of the window height (default 0.85). */
  maxHeightRatio?: number | undefined;
  children: ReactNode;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(props.open);
  const progress = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;

  useEffect(() => {
    let cancelled = false;
    if (props.open) {
      setMounted(true);
      drag.setValue(0);
      void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
        if (cancelled) return;
        Animated.timing(progress, {
          toValue: 1,
          duration: reduce ? 0 : 260,
          easing: Easing.bezier(0.22, 1, 0.36, 1),
          useNativeDriver: true,
        }).start();
      });
    } else if (mounted) {
      Animated.timing(progress, {
        toValue: 0,
        duration: 200,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && !cancelled) setMounted(false);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [drag, mounted, progress, props.open]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderMove: (_event, gesture) => drag.setValue(Math.max(0, gesture.dy)),
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dy > 90 || gesture.vy > 0.9) onClose.current();
        else Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
      },
      onPanResponderTerminate: () =>
        Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(),
    }),
  ).current;

  if (!mounted) return null;
  const translateY = Animated.add(
    progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }),
    drag,
  );
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={props.onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "flex-end" }}
      >
        <Animated.View
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundColor: "rgba(0, 0, 0, 0.4)",
            opacity: progress,
          }}
        >
          <Pressable
            style={{ flex: 1 }}
            onPress={props.onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          accessibilityLabel={props.accessibilityLabel}
          style={{
            maxHeight: height * (props.maxHeightRatio ?? 0.85),
            backgroundColor: c.bg,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            paddingBottom: Math.max(insets.bottom, 12),
            transform: [{ translateY }],
            shadowColor: "#000",
            shadowOpacity: 0.12,
            shadowRadius: 16,
            shadowOffset: { width: 0, height: -2 },
            elevation: 16,
          }}
        >
          <View
            {...pan.panHandlers}
            style={{ alignItems: "center", paddingTop: 8, paddingBottom: 4 }}
          >
            <View
              style={{
                width: 36,
                height: 5,
                borderRadius: 3,
                backgroundColor: c["border-strong"] ?? c.border,
              }}
            />
          </View>
          {props.children}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
