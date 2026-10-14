/* ----------------------------------------------------------------------------
   The full-screen image viewer, in the app instead of a browser: swipe between
   a message's images, pinch or double-tap to zoom, and share the image itself
   (downloaded first, so the share sheet offers Save Image and Copy).
   -------------------------------------------------------------------------- */
import { Directory, File, Paths } from "expo-file-system";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type NativeIconName } from "./icon";

export interface NativeViewerImage {
  /** A URL the image loads from (signed links are fine). */
  url: string;
  /** What the image shows, for VoiceOver. */
  alt: string;
  /** The file name to share it under, when known. */
  filename?: string | undefined;
}

export interface NativeImageViewerLabels {
  close: string;
  share: string;
  /** "2 of 3". */
  position: (index: number, count: number) => string;
  shareFailed: string;
}

const DEFAULT_LABELS: NativeImageViewerLabels = {
  close: "Close",
  share: "Share",
  position: (index, count) => `${index + 1} of ${count}`,
  shareFailed: "Couldn't share this image.",
};

function extensionOf(image: NativeViewerImage): string {
  const fromName = image.filename?.match(/\.([A-Za-z0-9]{2,5})$/u)?.[1];
  if (fromName) return fromName.toLowerCase();
  const fromUrl = image.url.split("?")[0]?.match(/\.([A-Za-z0-9]{2,5})$/u)?.[1];
  return fromUrl ? fromUrl.toLowerCase() : "jpg";
}

/** Download to the cache, then hand the file (not the link) to the share sheet. */
async function shareImage(image: NativeViewerImage): Promise<void> {
  const folder = new Directory(Paths.cache, "opengeni-share");
  if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
  const base = (image.filename ?? "image").replace(/\.[A-Za-z0-9]{2,5}$/u, "").slice(0, 60);
  const target = new File(folder, `${base || "image"}.${extensionOf(image)}`);
  const file = await File.downloadFileAsync(image.url, target, { idempotent: true });
  await Share.share(Platform.OS === "ios" ? { url: file.uri } : { message: image.url });
}

function ChromeButton(props: {
  icon: NativeIconName;
  label: string;
  onPress: () => void;
  busy?: boolean | undefined;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={10}
      disabled={props.busy}
      onPress={props.onPress}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.14)",
      })}
    >
      {props.busy ? (
        <ActivityIndicator size="small" color="#ffffff" />
      ) : (
        <Icon name={props.icon} size={18} color="#ffffff" />
      )}
    </Pressable>
  );
}

/** One page: the image fitted to the screen, zoomable up to 4×. */
function ZoomablePage(props: {
  image: NativeViewerImage;
  width: number;
  height: number;
  onZoomChange: (zoomed: boolean) => void;
}) {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const zoomed = useRef(false);
  const lastTap = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const { width, height } = props;
  return (
    <ScrollView
      ref={scroll}
      style={{ width, height }}
      maximumZoomScale={4}
      minimumZoomScale={1}
      centerContent
      bouncesZoom
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={64}
      onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const next = (event.nativeEvent.zoomScale ?? 1) > 1.01;
        if (next !== zoomed.current) {
          zoomed.current = next;
          props.onZoomChange(next);
        }
      }}
      contentContainerStyle={{ width, height, alignItems: "center", justifyContent: "center" }}
    >
      <Pressable
        accessible
        accessibilityRole="image"
        accessibilityLabel={props.image.alt}
        accessibilityHint="Double-tap to zoom"
        onPress={(event) => {
          // Double-tap zooms in on that spot, or back out.
          const now = Date.now();
          if (now - lastTap.current < 280) {
            lastTap.current = 0;
            if (zoomed.current) {
              scroll.current?.scrollResponderZoomTo({ x: 0, y: 0, width, height, animated: true });
            } else {
              const { locationX, locationY } = event.nativeEvent;
              scroll.current?.scrollResponderZoomTo({
                x: locationX - width / 6,
                y: locationY - height / 6,
                width: width / 3,
                height: height / 3,
                animated: true,
              });
            }
            return;
          }
          lastTap.current = now;
        }}
        style={{ width, height, alignItems: "center", justifyContent: "center" }}
      >
        <Image
          source={{ uri: props.image.url }}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
          onLoad={() => setLoaded(true)}
          style={{ width, height }}
        />
        {loaded ? null : (
          <View style={{ position: "absolute" }}>
            <ActivityIndicator color="#ffffff" />
          </View>
        )}
      </Pressable>
    </ScrollView>
  );
}

/**
 * Full-screen images over a dark backdrop. With several images, swipe between
 * them (paging pauses while one is zoomed). Close with the button or the
 * system back gesture.
 */
export function NativeImageViewer(props: {
  images: readonly NativeViewerImage[];
  /** The image to open on. */
  index: number;
  visible: boolean;
  onClose: () => void;
  labels?: Partial<NativeImageViewerLabels> | undefined;
}) {
  const labels = { ...DEFAULT_LABELS, ...props.labels };
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [index, setIndex] = useState(props.index);
  const [zoomed, setZoomed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const list = useRef<FlatList<NativeViewerImage>>(null);
  useEffect(() => {
    if (!props.visible) return;
    setIndex(props.index);
    setZoomed(false);
    setProblem(null);
  }, [props.visible, props.index]);
  const current = props.images[index] ?? props.images[0];
  const count = props.images.length;
  const share = () => {
    if (!current) return;
    setSharing(true);
    setProblem(null);
    void shareImage(current)
      .catch(() => setProblem(labels.shareFailed))
      .finally(() => setSharing(false));
  };
  return (
    <Modal
      visible={props.visible}
      animationType="fade"
      transparent
      statusBarTranslucent
      onRequestClose={props.onClose}
    >
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.96)" }}>
        <FlatList
          ref={list}
          data={props.images as NativeViewerImage[]}
          keyExtractor={(image, position) => `${position}:${image.url}`}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed && count > 1}
          initialScrollIndex={Math.min(props.index, Math.max(0, count - 1))}
          getItemLayout={(_data, position) => ({
            length: width,
            offset: width * position,
            index: position,
          })}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(event) => {
            const next = Math.round(event.nativeEvent.contentOffset.x / width);
            if (next !== index) {
              setIndex(next);
              setProblem(null);
            }
          }}
          renderItem={({ item }) => (
            <ZoomablePage image={item} width={width} height={height} onZoomChange={setZoomed} />
          )}
        />
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            top: insets.top + 8,
            left: 12,
            right: 12,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <ChromeButton icon="x" label={labels.close} onPress={props.onClose} />
          {count > 1 ? (
            <Text
              accessibilityRole="text"
              style={{ color: "rgba(255,255,255,0.86)", fontSize: 15, fontWeight: "600" }}
            >
              {labels.position(index, count)}
            </Text>
          ) : null}
          <ChromeButton icon="share-2" label={labels.share} onPress={share} busy={sharing} />
        </View>
        {problem ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              bottom: insets.bottom + 24,
              left: 24,
              right: 24,
              alignItems: "center",
            }}
          >
            <Text
              style={{
                color: "#ffffff",
                fontSize: 14,
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 12,
                overflow: "hidden",
                backgroundColor: "rgba(255,255,255,0.16)",
              }}
            >
              {problem}
            </Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}
