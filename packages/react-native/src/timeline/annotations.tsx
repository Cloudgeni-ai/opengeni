import type {
  DraftTimelineAnnotation,
  TimelineAnnotation,
  TimelineAnnotationSource,
} from "@opengeni/sdk";
import {
  ANNOTATION_MAX_NOTE_LENGTH,
  annotationDisplayOrdinal,
  annotationHasNote,
  annotationNoteNeedsDisclosure,
  truncateAnnotationQuote,
} from "@opengeni/react/timeline-model";
import { useOpenGeniText } from "@opengeni/react/messages";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from "react";
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Icon } from "./icon";
import { withAlpha } from "./primitives";
import { BottomSheet } from "./sheet";
import {
  annotationSourceTestId,
  measureQuoteAnchors,
  type QuoteAnchor,
  type QuoteAnchorQuery,
  type QuoteBox,
} from "./text-selection";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   Timeline annotations at phone width: the quote cards in sent messages, the
   composer and queue chips, the review sheet where notes are written (the
   web's annotations dialog) and the numbered badge where a draft quote ends.
   -------------------------------------------------------------------------- */

export type NativeAnnotationLike = DraftTimelineAnnotation | TimelineAnnotation;

/**
 * Reveals a quote in the timeline: scrolls its words into view and flashes
 * them (the whole message when they can't be located). False when the
 * message is not loaded.
 */
export type AnnotationReveal = (
  source: TimelineAnnotationSource,
  quote?: QuoteAnchorQuery,
) => boolean;

/** The text a revealed quote is found by. */
export function annotationQuoteQuery(annotation: NativeAnnotationLike): QuoteAnchorQuery {
  return {
    quote: annotation.quote,
    before: annotation.source.contextBefore,
    after: annotation.source.contextAfter,
  };
}

type DraftMarker = {
  id: string;
  ordinal: number;
  incomplete: boolean;
  quote: string;
  before: string;
  after: string;
};

export type AnnotationSourceNode = ComponentRef<typeof View>;

type AnnotationSourcesValue = {
  register: (sourceKey: string, node: AnnotationSourceNode | null) => void;
  flash: AnnotationFlash | null;
  drafts: ReadonlyMap<string, readonly DraftMarker[]>;
  onSelectDraft?: ((id: string) => void) | undefined;
};

/** A reveal's highlight: one message, and the quote in it when known. */
export type AnnotationFlash = { sourceKey: string; token: number; quote?: QuoteAnchorQuery };

export const AnnotationSourcesContext = createContext<AnnotationSourcesValue | null>(null);

/** Draft annotations grouped by the message they quote. */
export function draftMarkersBySource(
  annotations: readonly DraftTimelineAnnotation[] | undefined,
): Map<string, DraftMarker[]> {
  const markers = new Map<string, DraftMarker[]>();
  (annotations ?? []).forEach((annotation, index) => {
    const list = markers.get(annotation.source.eventId) ?? [];
    list.push({
      id: annotation.id,
      ordinal: index + 1,
      incomplete: !annotationHasNote(annotation.note),
      quote: annotation.quote,
      before: annotation.source.contextBefore,
      after: annotation.source.contextAfter,
    });
    markers.set(annotation.source.eventId, list);
  });
  return markers;
}

function quotePreview(quote: string): string {
  const trimmed = quote.trim();
  return trimmed.includes("\n") ? trimmed : trimmed.replace(/\s+/g, " ");
}

/**
 * A message body that can be quoted: marks its text for native selection
 * (Add note), shows a numbered badge where each draft quote ends (the web's
 * annotation markers) and briefly highlights when a quote of it is revealed.
 */
export function AnnotationSourceView({
  sourceKey,
  children,
  style,
}: {
  sourceKey: string | undefined;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useNativeTimelineTheme();
  const sources = useContext(AnnotationSourcesContext);
  const glow = useRef(new Animated.Value(0)).current;
  const flash = sourceKey && sources?.flash?.sourceKey === sourceKey ? sources.flash : null;
  // The revealed quote's lines, or null to flash the whole message.
  const [flashBoxes, setFlashBoxes] = useState<QuoteBox[] | null>(null);
  useEffect(() => {
    if (!flash || !sourceKey) return;
    let cancelled = false;
    const start = (boxes: QuoteBox[] | null) => {
      if (cancelled) return;
      setFlashBoxes(boxes);
      glow.setValue(1);
      Animated.timing(glow, {
        toValue: 0,
        duration: boxes ? 1800 : 1400,
        delay: 300,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    };
    if (!flash.quote) start(null);
    else
      void measureQuoteAnchors(sourceKey, [flash.quote]).then(([anchor]) =>
        start(anchor?.boxes.length ? anchor.boxes : null),
      );
    return () => {
      cancelled = true;
    };
  }, [flash, glow, sourceKey]);
  const register = sources?.register;
  const markers = sourceKey ? sources?.drafts.get(sourceKey) : undefined;
  const [anchors, setAnchors] = useState<{
    markers: readonly DraftMarker[];
    at: (QuoteAnchor | null)[];
  } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const measure = useCallback(() => {
    if (!sourceKey || !markers?.length) return;
    const queries = markers.map(({ quote, before, after }) => ({ quote, before, after }));
    void measureQuoteAnchors(sourceKey, queries).then((at) => setAnchors({ markers, at }));
  }, [markers, sourceKey]);
  // Text lays out after the view; measure once it has drawn, and again when
  // the drafts or the width change.
  useEffect(() => {
    if (!markers?.length) {
      setAnchors(null);
      return;
    }
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [markers, measure, size.width, size.height]);
  return (
    <Animated.View
      ref={(node: AnnotationSourceNode | null) => {
        if (sourceKey && register) register(sourceKey, node);
      }}
      testID={annotationSourceTestId(sourceKey)}
      collapsable={false}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setSize((current) =>
          current.width === width && current.height === height ? current : { width, height },
        );
      }}
      style={[
        style,
        {
          borderRadius: theme.radius.md,
          backgroundColor: flashBoxes
            ? "transparent"
            : glow.interpolate({
                inputRange: [0, 1],
                outputRange: [withAlpha(theme.colors.fg, 0), withAlpha(theme.colors.fg, 0.08)],
              }),
        },
      ]}
    >
      {flashBoxes ? <QuoteFlash boxes={flashBoxes} glow={glow} /> : null}
      {markers?.length && anchors?.markers === markers ? (
        <QuoteHighlights anchors={anchors.at} />
      ) : null}
      {children}
      {markers?.length && anchors?.markers === markers ? (
        <QuoteBadges
          markers={markers}
          anchors={anchors.at}
          size={size}
          onSelect={sources?.onSelectDraft}
        />
      ) : null}
    </Animated.View>
  );
}

const BADGE_SIZE = 15;

/** A line box's identity: where it sits (two quotes never share a line box). */
function boxKey(box: QuoteBox): string {
  return `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}`;
}

/** A revealed quote's lines light up, then fade, under its text. */
function QuoteFlash({ boxes, glow }: { boxes: readonly QuoteBox[]; glow: Animated.Value }) {
  const theme = useNativeTimelineTheme();
  const tint = withAlpha(theme.colors.accent, theme.scheme === "dark" ? 0.45 : 0.28);
  return (
    <>
      {boxes.map((box) => (
        <Animated.View
          key={boxKey(box)}
          pointerEvents="none"
          style={{
            position: "absolute",
            left: box.x - 3,
            top: box.y - 2,
            width: box.width + 6,
            height: box.height + 4,
            borderRadius: 5,
            backgroundColor: tint,
            opacity: glow,
          }}
        />
      ))}
    </>
  );
}

/**
 * A soft tint with an accent underline behind each draft quote, so what is
 * quoted reads at a glance and never looks like an inline code span. Drawn
 * before the message, under its text.
 */
function QuoteHighlights({ anchors }: { anchors: readonly (QuoteAnchor | null)[] }) {
  const theme = useNativeTimelineTheme();
  const dark = theme.scheme === "dark";
  const tint = withAlpha(theme.colors.accent, dark ? 0.16 : 0.08);
  const rule = withAlpha(theme.colors.accent, dark ? 0.7 : 0.55);
  return (
    <>
      {anchors.flatMap((anchor) =>
        (anchor?.boxes ?? []).map((box) => (
          <View
            key={boxKey(box)}
            pointerEvents="none"
            style={{
              position: "absolute",
              left: box.x - 2,
              top: box.y - 1,
              width: box.width + 4,
              height: box.height + 2,
              borderTopLeftRadius: 3,
              borderTopRightRadius: 3,
              borderBottomWidth: 1.5,
              borderBottomColor: rule,
              backgroundColor: tint,
            }}
          />
        )),
      )}
    </>
  );
}

/**
 * Numbered badges at the top-right corner of each quote, mostly in the gap
 * above its line so they cover no text (the web's markers sit on the quote's
 * end the same way). A quote that cannot be located (text that changed, or
 * no native measuring) gets its badge at the end of the message instead.
 */
function QuoteBadges({
  markers,
  anchors,
  size,
  onSelect,
}: {
  markers: readonly DraftMarker[];
  anchors: readonly (QuoteAnchor | null)[];
  size: { width: number; height: number };
  onSelect?: ((id: string) => void) | undefined;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  let unplaced = 0;
  return (
    <>
      {markers.map((marker, index) => {
        const anchor = anchors[index];
        // Unplaced badges line up along the message's bottom edge.
        const center = anchor
          ? { x: anchor.x + 2, y: anchor.top - 1 }
          : {
              x: size.width - BADGE_SIZE / 2 - unplaced++ * (BADGE_SIZE + 4),
              y: size.height - BADGE_SIZE / 2,
            };
        const left = Math.min(Math.max(center.x - BADGE_SIZE / 2, 0), size.width - BADGE_SIZE);
        return (
          <Pressable
            key={marker.id}
            accessibilityRole="button"
            accessibilityLabel={t("timelineAnnotationMarkers.annotationOrdinal", {
              ordinal: marker.ordinal,
            })}
            hitSlop={14}
            disabled={!onSelect}
            onPress={() => onSelect?.(marker.id)}
            style={({ pressed }) => ({
              position: "absolute",
              left,
              top: center.y - BADGE_SIZE / 2,
              zIndex: marker.ordinal,
              minWidth: BADGE_SIZE,
              height: BADGE_SIZE,
              paddingHorizontal: 2,
              borderRadius: BADGE_SIZE / 2,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: c.accent,
              borderWidth: marker.incomplete ? 1 : 0,
              borderColor: withAlpha(c["accent-fg"], 0.35),
              opacity: pressed ? 0.7 : 1,
              shadowColor: "#000",
              shadowOpacity: 0.12,
              shadowRadius: 2,
              shadowOffset: { width: 0, height: 1 },
            })}
          >
            <Text
              style={{
                ...fontStyle(theme, 600),
                fontSize: 10,
                lineHeight: 12,
                color: c["accent-fg"],
                fontVariant: ["tabular-nums"],
              }}
            >
              {marker.ordinal}
            </Text>
          </Pressable>
        );
      })}
    </>
  );
}

/**
 * A quote's accent rule beside its content. `shrink` sizes the content to
 * itself (inside a bubble that wraps its content: a flex-basis-0 column there
 * is measured unwrapped and its wrapped lines spill out); otherwise it fills
 * the row.
 */
function AccentRow({ children, shrink = false }: { children: ReactNode; shrink?: boolean }) {
  const theme = useNativeTimelineTheme();
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      <View
        style={{
          width: 2,
          borderRadius: 1,
          backgroundColor: withAlpha(theme.colors.accent, 0.55),
        }}
      />
      <View style={shrink ? { flexShrink: 1, minWidth: 0 } : { flex: 1, minWidth: 0 }}>
        {children}
      </View>
    </View>
  );
}

function OrdinalLabel({ ordinal }: { ordinal: number }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  return (
    <Text
      style={{
        ...fontStyle(theme, 500),
        fontSize: theme.size.xs,
        lineHeight: 16,
        color: theme.colors["fg-subtle"],
        fontVariant: ["tabular-nums"],
      }}
    >
      {t("timelineAnnotations.annotationOrdinal", { ordinal })}
    </Text>
  );
}

function QuoteButton({
  annotation,
  onReveal,
}: {
  annotation: NativeAnnotationLike;
  onReveal?: AnnotationReveal | undefined;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const [unavailable, setUnavailable] = useState(false);
  const text = (
    <Text
      numberOfLines={2}
      style={{
        ...fontStyle(theme),
        fontSize: theme.size.sm,
        lineHeight: 20,
        color: theme.colors["fg-muted"],
      }}
    >
      {quotePreview(annotation.quote)}
    </Text>
  );
  if (!onReveal) return text;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(
          "timelineAnnotationChrome.viewSourcelabelSourceTruncateannotationquote",
          {
            sourceLabel:
              annotation.source.label?.trim() ||
              (annotation.source.kind === "user_message"
                ? t("timelineAnnotationShared.yourMessage")
                : annotation.source.kind === "assistant_message"
                  ? t("timelineAnnotationShared.assistant")
                  : t("timelineAnnotationShared.toolOutput")),
            truncateAnnotationQuote: truncateAnnotationQuote(annotation.quote, 88),
          },
        )}
        onPress={() =>
          setUnavailable(!onReveal(annotation.source, annotationQuoteQuery(annotation)))
        }
        style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1, paddingVertical: 2 })}
      >
        {text}
      </Pressable>
      {unavailable ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{
            ...fontStyle(theme),
            fontSize: theme.size.xs,
            lineHeight: 16,
            color: theme.colors["status-waiting"],
          }}
        >
          {t("timelineAnnotations.sourceIsOutsideTheLoaded")}
        </Text>
      ) : null}
    </View>
  );
}

function NotePreview({ note, ordinal }: { note: string; ordinal: number }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const [expanded, setExpanded] = useState(false);
  if (!note) return null;
  const collapsible = annotationNoteNeedsDisclosure(note);
  return (
    <View style={{ marginTop: 2 }}>
      <Text
        selectable
        numberOfLines={expanded ? undefined : 4}
        style={{
          ...fontStyle(theme),
          fontSize: theme.size.sm,
          lineHeight: 20,
          color: theme.colors.fg,
        }}
      >
        {note}
      </Text>
      {collapsible ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            expanded
              ? t("timelineAnnotationChrome.showLessAnnotationOrdinal", { ordinal })
              : t("timelineAnnotationChrome.showMoreAnnotationOrdinal", { ordinal })
          }
          hitSlop={8}
          onPress={() => setExpanded((current) => !current)}
          style={{ alignSelf: "flex-start", paddingVertical: 4 }}
        >
          <Text
            style={{
              ...fontStyle(theme, 500),
              fontSize: theme.size.xs,
              color: theme.colors["fg-muted"],
            }}
          >
            {expanded
              ? t("timelineAnnotationChrome.showLess")
              : t("timelineAnnotationChrome.showMore")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The quotes and notes a sent message carries, inside its bubble. */
export function SentAnnotationCards({
  annotations,
  onReveal,
}: {
  annotations: readonly NativeAnnotationLike[];
  onReveal?: AnnotationReveal | undefined;
}) {
  if (annotations.length === 0) return null;
  return (
    <View style={{ gap: 10 }}>
      {annotations.map((annotation, index) => {
        const ordinal = annotationDisplayOrdinal(annotation, index);
        return (
          <AccentRow key={annotation.id} shrink>
            <OrdinalLabel ordinal={ordinal} />
            <QuoteButton annotation={annotation} onReveal={onReveal} />
            <NotePreview note={annotation.note} ordinal={ordinal} />
          </AccentRow>
        );
      })}
    </View>
  );
}

/**
 * The "N annotations" chip: in the composer (editable, with remove all) or on
 * a queued message (compact). Tinted while a quote still needs its note.
 */
export function AnnotationsChip({
  annotations,
  onPress,
  onClear,
  compact = false,
}: {
  annotations: readonly NativeAnnotationLike[];
  onPress: () => void;
  onClear?: (() => void) | undefined;
  compact?: boolean | undefined;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  if (annotations.length === 0) return null;
  const countLabel = t("counts.annotations", { count: annotations.length });
  const incomplete =
    onClear !== undefined && annotations.some((item) => !annotationHasNote(item.note));
  const height = compact ? 26 : 32;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        height,
        borderRadius: height / 2,
        borderWidth: 1,
        borderColor: incomplete ? withAlpha(c.accent, 0.45) : c.border,
        backgroundColor: incomplete ? c["accent-soft"] : c["surface-1"],
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("timelineAnnotations.reviewCountlabel", { countLabel })}
        hitSlop={{ top: (44 - height) / 2, bottom: (44 - height) / 2 }}
        onPress={onPress}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          height,
          paddingLeft: compact ? 8 : 10,
          paddingRight: onClear ? 2 : compact ? 8 : 12,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Icon name="quote" size={compact ? 11 : 13} color={c.accent} />
        <Text
          numberOfLines={1}
          style={{
            ...fontStyle(theme, 500),
            fontSize: compact ? theme.size.xs : theme.size.sm,
            color: c["fg-muted"],
          }}
        >
          {countLabel}
        </Text>
      </Pressable>
      {onClear ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("timelineAnnotations.removeAllAnnotations")}
          hitSlop={{ top: 6, bottom: 6, right: 6 }}
          onPress={onClear}
          style={({ pressed }) => ({
            width: height,
            height,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.5 : 1,
          })}
        >
          <Icon name="x" size={13} color={c["fg-subtle"]} />
        </Pressable>
      ) : null}
    </View>
  );
}

type NoteInput = ComponentRef<typeof TextInput>;

/**
 * Every quote with its note, as the web's annotations dialog: editable in the
 * composer (write, remove; Return moves to the next empty note, then back to
 * the message), read-only for a queued message. A quote reveals its message.
 */
export function AnnotationsSheet({
  open,
  onClose,
  annotations,
  editable,
  focusId,
  onFocusConsumed,
  onUpdate,
  onRemove,
  onReveal,
  onCommit,
}: {
  open: boolean;
  onClose: () => void;
  annotations: readonly NativeAnnotationLike[];
  editable: boolean;
  focusId?: string | null | undefined;
  onFocusConsumed?: (() => void) | undefined;
  onUpdate?: ((id: string, note: string) => void) | undefined;
  onRemove?: ((id: string) => void) | undefined;
  onReveal?: AnnotationReveal | undefined;
  /** Every note is written: back to the message. */
  onCommit?: (() => void) | undefined;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const inputs = useRef(new Map<string, NoteInput>());
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const rowTops = useRef(new Map<string, number>());
  const empty = annotations.length === 0;

  // Removing the last quote leaves nothing to review.
  useEffect(() => {
    if (open && empty) onClose();
  }, [empty, onClose, open]);

  const focusNote = (id: string) => {
    const top = rowTops.current.get(id);
    if (top !== undefined) scroll.current?.scrollTo({ y: Math.max(0, top - 8), animated: true });
    inputs.current.get(id)?.focus();
  };

  // A new quote (or a send with an empty note) opens on its note. The sheet
  // slides in first; focusing during the slide drops the keyboard request.
  useEffect(() => {
    if (!open || !focusId || !editable) return;
    const timer = setTimeout(() => {
      focusNote(focusId);
      onFocusConsumed?.();
    }, 320);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, focusId, open]);

  const commit = (fromId: string) => {
    const incomplete = annotations.filter((item) => !annotationHasNote(item.note));
    if (incomplete.length === 0) {
      onCommit?.();
      return;
    }
    const fromIndex = annotations.findIndex((item) => item.id === fromId);
    const next = incomplete.find((item) => annotations.indexOf(item) > fromIndex) ?? incomplete[0]!;
    focusNote(next.id);
  };

  const incompleteCount = annotations.filter((item) => !annotationHasNote(item.note)).length;
  const countLabel = t("counts.annotations", { count: annotations.length });
  return (
    <BottomSheet
      open={open && !empty}
      onClose={onClose}
      maxHeightRatio={0.8}
      accessibilityLabel={
        editable
          ? t("timelineAnnotationsDialog.editQuotedNotes")
          : t("timelineAnnotationsDialog.quotedNotes")
      }
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingLeft: 20,
          paddingRight: 8,
          paddingBottom: 4,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{ ...fontStyle(theme, 600), fontSize: theme.size.md, color: c.fg }}
        >
          {countLabel}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (editable && incompleteCount === 0 && onCommit) onCommit();
            else onClose();
          }}
          style={({ pressed }) => ({
            height: 44,
            paddingHorizontal: 12,
            justifyContent: "center",
            opacity: pressed ? 0.5 : 1,
          })}
        >
          <Text style={{ ...fontStyle(theme, 600), fontSize: theme.size.md, color: c.fg }}>
            {t("native.timeline.annotations.done")}
          </Text>
        </Pressable>
      </View>
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12, gap: 18 }}
        style={{ flexGrow: 0 }}
      >
        {annotations.map((annotation, index) => {
          const ordinal = annotationDisplayOrdinal(annotation, index);
          const last = index === annotations.length - 1;
          const othersIncomplete = annotations.some(
            (item) => item.id !== annotation.id && !annotationHasNote(item.note),
          );
          return (
            <View
              key={annotation.id}
              onLayout={(event) => rowTops.current.set(annotation.id, event.nativeEvent.layout.y)}
            >
              <AccentRow>
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 4 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <OrdinalLabel ordinal={ordinal} />
                    <QuoteButton
                      annotation={annotation}
                      onReveal={
                        onReveal
                          ? (source, quote) => {
                              const revealed = onReveal(source, quote);
                              if (revealed) onClose();
                              return revealed;
                            }
                          : undefined
                      }
                    />
                  </View>
                  {editable && onRemove ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("timelineAnnotationsDialog.removeAnnotationOrdinal", {
                        ordinal,
                      })}
                      onPress={() => onRemove(annotation.id)}
                      style={({ pressed }) => ({
                        width: 36,
                        height: 36,
                        marginTop: -6,
                        marginRight: -10,
                        alignItems: "center",
                        justifyContent: "center",
                        opacity: pressed ? 0.5 : 1,
                      })}
                    >
                      <Icon name="x" size={15} color={c["fg-subtle"]} />
                    </Pressable>
                  ) : null}
                </View>
                {editable && onUpdate ? (
                  <TextInput
                    ref={(node) => {
                      if (node) inputs.current.set(annotation.id, node);
                      else inputs.current.delete(annotation.id);
                    }}
                    value={annotation.note}
                    onChangeText={(note) => onUpdate(annotation.id, note)}
                    placeholder={t("timelineAnnotationChrome.addANote")}
                    placeholderTextColor={c["fg-subtle"]}
                    accessibilityLabel={t("timelineAnnotationChrome.note")}
                    maxLength={ANNOTATION_MAX_NOTE_LENGTH}
                    multiline
                    submitBehavior="submit"
                    returnKeyType={othersIncomplete || (last && !onCommit) ? "next" : "done"}
                    onSubmitEditing={() => commit(annotation.id)}
                    style={{
                      ...fontStyle(theme),
                      fontSize: theme.size.md,
                      lineHeight: 22,
                      color: c.fg,
                      marginTop: 6,
                      minHeight: 40,
                      maxHeight: 132,
                      paddingHorizontal: 12,
                      paddingTop: 9,
                      paddingBottom: 9,
                      borderRadius: theme.radius.md,
                      backgroundColor: c["surface-2"],
                      borderWidth: 1,
                      borderColor: c.border,
                    }}
                  />
                ) : (
                  <NotePreview note={annotation.note} ordinal={ordinal} />
                )}
              </AccentRow>
            </View>
          );
        })}
        {editable && incompleteCount > 0 ? (
          <Text
            style={{
              ...fontStyle(theme),
              fontSize: theme.size.xs,
              lineHeight: 16,
              color: c["fg-subtle"],
            }}
          >
            {t("composerMessages.addANoteToEach")}
          </Text>
        ) : null}
      </ScrollView>
    </BottomSheet>
  );
}
