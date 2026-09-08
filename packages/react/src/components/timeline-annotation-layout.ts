export type AnnotationBox = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type AnnotationBadgeAnchor = {
  id: string;
  ordinal: number;
  left: number;
  top: number;
  incomplete: boolean;
};

export const ANNOTATION_BADGE_GAP_PX = 20;
export const ANNOTATION_REVIEW_DIALOG_WIDTH_PX = 400;
export const ANNOTATION_REVIEW_DIALOG_MAX_HEIGHT_PX = 32 * 16;
export const ANNOTATION_REVIEW_DIALOG_MIN_HEIGHT_PX = 160;
export const ANNOTATION_REVIEW_MARGIN_PX = 12;
export const ANNOTATION_NOTE_PREVIEW_CHARS = 280;
export const ANNOTATION_CARD_STACK_SCROLL_AT = 4;

export function annotationBoxIntersects(a: AnnotationBox, b: AnnotationBox): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

export function annotationViewportBox(
  viewportWidth: number,
  viewportHeight: number,
  scroller?: AnnotationBox | null,
): AnnotationBox {
  const viewport: AnnotationBox = {
    left: 0,
    top: 0,
    right: Math.max(1, viewportWidth),
    bottom: Math.max(1, viewportHeight),
  };
  if (!scroller || scroller.right - scroller.left <= 0 || scroller.bottom - scroller.top <= 0) {
    return viewport;
  }
  return {
    left: Math.max(viewport.left, scroller.left),
    top: Math.max(viewport.top, scroller.top),
    right: Math.min(viewport.right, scroller.right),
    bottom: Math.min(viewport.bottom, scroller.bottom),
  };
}

export function annotationNoteNeedsDisclosure(note: string): boolean {
  const trimmed = note.trim();
  if (trimmed.length === 0) return false;
  return trimmed.length > ANNOTATION_NOTE_PREVIEW_CHARS || trimmed.split("\n").length > 4;
}

export function layoutAnnotationBadges(
  anchors: readonly AnnotationBadgeAnchor[],
  viewport: AnnotationBox,
  gap = ANNOTATION_BADGE_GAP_PX,
): AnnotationBadgeAnchor[] {
  const minLeft = viewport.left + ANNOTATION_REVIEW_MARGIN_PX;
  const maxLeft = viewport.right - ANNOTATION_REVIEW_MARGIN_PX;
  const minTop = viewport.top + 8;
  const placed: AnnotationBadgeAnchor[] = [];
  for (const anchor of [...anchors].sort((left, right) => left.ordinal - right.ordinal)) {
    const next: AnnotationBadgeAnchor = {
      ...anchor,
      left: Math.min(Math.max(anchor.left, minLeft), Math.max(minLeft, maxLeft)),
      top: Math.max(minTop, anchor.top),
    };
    let guard = 0;
    while (guard++ < 32) {
      const collider = placed.find(
        (other) => Math.hypot(next.left - other.left, next.top - other.top) < gap,
      );
      if (!collider) break;
      const shifted = collider.left + gap;
      if (shifted <= maxLeft) {
        next.left = shifted;
        continue;
      }
      next.left = Math.min(Math.max(anchor.left, minLeft), Math.max(minLeft, maxLeft));
      next.top = collider.top + gap;
    }
    placed.push(next);
  }
  return placed;
}

export function clampAnnotationDialogPlacement(input: {
  triggerLeft: number;
  triggerTop: number;
  triggerBottom: number;
  contentHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  panelWidth?: number;
}): {
  left: number;
  top: number;
  maxHeight: number;
  above: boolean;
} {
  const margin = ANNOTATION_REVIEW_MARGIN_PX;
  const panelWidth = Math.min(
    input.panelWidth ?? ANNOTATION_REVIEW_DIALOG_WIDTH_PX,
    Math.max(1, input.viewportWidth - margin * 2),
  );
  const left = Math.min(
    Math.max(margin, input.triggerLeft),
    Math.max(margin, input.viewportWidth - panelWidth - margin),
  );
  const spaceBelow = input.viewportHeight - input.triggerBottom - margin;
  const spaceAbove = input.triggerTop - margin;
  const above = spaceBelow < Math.min(input.contentHeight, 200) && spaceAbove > spaceBelow;
  const available = Math.max(
    ANNOTATION_REVIEW_DIALOG_MIN_HEIGHT_PX,
    above ? spaceAbove : spaceBelow,
  );
  const maxHeight = Math.min(
    Math.max(input.contentHeight, ANNOTATION_REVIEW_DIALOG_MIN_HEIGHT_PX),
    available,
    Math.floor(input.viewportHeight * 0.7),
    ANNOTATION_REVIEW_DIALOG_MAX_HEIGHT_PX,
  );
  if (above) {
    return {
      left,
      top: Math.max(margin, input.triggerTop - 8 - maxHeight),
      maxHeight,
      above: true,
    };
  }
  const unclampedTop = input.triggerBottom + 8;
  const top = Math.min(
    unclampedTop,
    Math.max(margin, input.viewportHeight - margin - maxHeight),
  );
  return { left, top: Math.max(margin, top), maxHeight, above: false };
}
