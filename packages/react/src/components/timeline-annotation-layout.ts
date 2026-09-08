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

export const ANNOTATION_BADGE_GAP_PX = 32;
export const ANNOTATION_BADGE_MIN_GAP_PX = 12;
export const ANNOTATION_REVIEW_DIALOG_WIDTH_PX = 400;
export const ANNOTATION_REVIEW_DIALOG_MAX_HEIGHT_PX = 32 * 16;
export const ANNOTATION_REVIEW_DIALOG_MIN_HEIGHT_PX = 160;
export const ANNOTATION_REVIEW_DIALOG_FLOOR_HEIGHT_PX = 80;
export const ANNOTATION_REVIEW_MARGIN_PX = 12;
export const ANNOTATION_NOTE_PREVIEW_CHARS = 280;
export const ANNOTATION_CARD_STACK_SCROLL_AT = 4;

function clampAnnotationAxis(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

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

function annotationAxisStops(min: number, max: number, gap: number): number[] {
  if (max <= min) return [min];
  const stops: number[] = [];
  for (let value = min; value <= max + 1e-6; value += gap) {
    stops.push(value);
  }
  return stops;
}

function annotationPointKey(left: number, top: number): string {
  return `${Math.round(left * 100) / 100},${Math.round(top * 100) / 100}`;
}

function annotationPointFree(
  left: number,
  top: number,
  placed: readonly AnnotationBadgeAnchor[],
  gap: number,
): boolean {
  return placed.every((other) => Math.hypot(left - other.left, top - other.top) >= gap);
}

export function annotationBadgePackGap(
  viewport: AnnotationBox,
  count: number,
  preferred = ANNOTATION_BADGE_GAP_PX,
): number {
  if (count <= 1) return preferred;
  const width = Math.max(
    1,
    viewport.right - ANNOTATION_REVIEW_MARGIN_PX - (viewport.left + ANNOTATION_REVIEW_MARGIN_PX),
  );
  const height = Math.max(
    1,
    viewport.bottom - ANNOTATION_REVIEW_MARGIN_PX - (viewport.top + 8),
  );
  let gap = preferred;
  const capacity = (step: number) =>
    (Math.floor(width / step) + 1) * (Math.floor(height / step) + 1);
  while (gap > ANNOTATION_BADGE_MIN_GAP_PX && capacity(gap) < count) {
    gap -= 1;
  }
  return gap;
}

const ANNOTATION_BADGE_SHIFT_DIRS: Array<[number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

export function layoutAnnotationBadges(
  anchors: readonly AnnotationBadgeAnchor[],
  viewport: AnnotationBox,
  preferredGap = ANNOTATION_BADGE_GAP_PX,
): AnnotationBadgeAnchor[] {
  const minLeft = viewport.left + ANNOTATION_REVIEW_MARGIN_PX;
  const maxLeft = viewport.right - ANNOTATION_REVIEW_MARGIN_PX;
  const minTop = viewport.top + 8;
  const maxTop = viewport.bottom - ANNOTATION_REVIEW_MARGIN_PX;
  const gap = annotationBadgePackGap(viewport, anchors.length, preferredGap);
  const cells = annotationAxisStops(minLeft, maxLeft, gap).flatMap((left) =>
    annotationAxisStops(minTop, maxTop, gap).map((top) => ({ left, top })),
  );
  const placed: AnnotationBadgeAnchor[] = [];
  for (const anchor of [...anchors].sort((left, right) => left.ordinal - right.ordinal)) {
    const originLeft = clampAnnotationAxis(anchor.left, minLeft, maxLeft);
    const originTop = clampAnnotationAxis(anchor.top, minTop, maxTop);
    const seen = new Set<string>();
    const candidates: Array<{ left: number; top: number }> = [];
    const pushCandidate = (left: number, top: number) => {
      if (left < minLeft || left > maxLeft || top < minTop || top > maxTop) return;
      const key = annotationPointKey(left, top);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ left, top });
    };
    pushCandidate(originLeft, originTop);
    for (const [dx, dy] of ANNOTATION_BADGE_SHIFT_DIRS) {
      const colliders = [...placed].sort(
        (left, right) =>
          right.left * dx + right.top * dy - (left.left * dx + left.top * dy),
      );
      for (const collider of colliders) {
        pushCandidate(collider.left + dx * gap, collider.top + dy * gap);
      }
    }
    const maxRadius =
      Math.ceil(Math.max(maxLeft - minLeft, maxTop - minTop) / Math.max(gap, 1)) + 1;
    for (let radius = 1; radius <= maxRadius; radius++) {
      const ring: Array<[number, number]> = [];
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          ring.push([dx, dy]);
        }
      }
      ring.sort((left, right) => {
        const leftDir = (left[0] < 0 ? 2 : 0) + (left[1] < 0 ? 1 : 0);
        const rightDir = (right[0] < 0 ? 2 : 0) + (right[1] < 0 ? 1 : 0);
        if (leftDir !== rightDir) return leftDir - rightDir;
        const hypot = Math.hypot(left[0], left[1]) - Math.hypot(right[0], right[1]);
        if (hypot !== 0) return hypot;
        if (left[0] !== right[0]) return right[0] - left[0];
        return left[1] - right[1];
      });
      for (const [dx, dy] of ring) {
        pushCandidate(originLeft + dx * gap, originTop + dy * gap);
      }
    }
    for (const cell of cells) {
      pushCandidate(cell.left, cell.top);
    }
    const free = candidates.find((point) =>
      annotationPointFree(point.left, point.top, placed, gap),
    );
    let chosen = free ?? candidates[0]!;
    if (!free && placed.length > 0) {
      let bestMin = Number.NEGATIVE_INFINITY;
      for (const point of candidates) {
        const minDist = placed.reduce(
          (current, other) =>
            Math.min(current, Math.hypot(point.left - other.left, point.top - other.top)),
          Number.POSITIVE_INFINITY,
        );
        if (minDist > bestMin) {
          bestMin = minDist;
          chosen = point;
        }
      }
    }
    placed.push({ ...anchor, left: chosen.left, top: chosen.top });
  }
  return placed;
}

export function scrollAnnotationRowIntoList(
  list: HTMLElement | null | undefined,
  row: HTMLElement | null | undefined,
): void {
  if (!list || !row || !list.contains(row)) return;
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  if (rowRect.top < listRect.top) {
    list.scrollTop -= listRect.top - rowRect.top;
    return;
  }
  if (rowRect.bottom > listRect.bottom) {
    list.scrollTop += rowRect.bottom - listRect.bottom;
  }
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
  const viewportBudget = Math.max(
    ANNOTATION_REVIEW_DIALOG_FLOOR_HEIGHT_PX,
    input.viewportHeight - margin * 2,
  );
  const available = Math.max(
    Math.min(ANNOTATION_REVIEW_DIALOG_MIN_HEIGHT_PX, viewportBudget),
    above ? spaceAbove : spaceBelow,
  );
  let maxHeight = Math.min(
    Math.max(input.contentHeight, Math.min(ANNOTATION_REVIEW_DIALOG_MIN_HEIGHT_PX, viewportBudget)),
    available,
    Math.floor(input.viewportHeight * 0.7) || viewportBudget,
    ANNOTATION_REVIEW_DIALOG_MAX_HEIGHT_PX,
    viewportBudget,
  );
  let top = above
    ? Math.max(margin, input.triggerTop - 8 - maxHeight)
    : Math.min(
        input.triggerBottom + 8,
        Math.max(margin, input.viewportHeight - margin - maxHeight),
      );
  top = Math.max(margin, top);
  maxHeight = Math.min(
    maxHeight,
    Math.max(ANNOTATION_REVIEW_DIALOG_FLOOR_HEIGHT_PX, input.viewportHeight - margin - top),
  );
  return { left, top, maxHeight, above };
}
