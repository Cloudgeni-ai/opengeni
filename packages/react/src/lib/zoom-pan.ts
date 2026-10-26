/**
 * The geometry of a zoomable, pannable image: pure functions over the image's
 * own pixel size, the viewport it is shown in, and where it sits there.
 */

export type ZoomSize = { width: number; height: number };
export type ZoomPoint = { x: number; y: number };
/** The image's scale (1 = its own pixels) and its top-left corner in the viewport. */
export type ZoomView = { scale: number; x: number; y: number; fit: boolean };

/** Fitting enlarges a small image at most this much, so tiny screenshots are readable. */
export const MAX_FIT_UPSCALE = 2;
export const MAX_ZOOM = 8;
/** Space kept around a fitted image. */
export const FIT_PADDING = 16;
const STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
const EPSILON = 0.005;

export function fitScale(image: ZoomSize, viewport: ZoomSize, padding = FIT_PADDING): number {
  const width = Math.max(1, viewport.width - padding * 2);
  const height = Math.max(1, viewport.height - padding * 2);
  return Math.min(width / image.width, height / image.height, MAX_FIT_UPSCALE);
}

/** Zooming out stops at the fitted size, or at actual size for an enlarged small image. */
export function minScale(image: ZoomSize, viewport: ZoomSize): number {
  return Math.min(fitScale(image, viewport), 1);
}

function clampAxis(offset: number, content: number, viewport: number): number {
  // Smaller than the viewport: centred. Larger: no gap at either edge.
  if (content <= viewport) return (viewport - content) / 2;
  return Math.min(0, Math.max(viewport - content, offset));
}

export function clampView(view: ZoomView, image: ZoomSize, viewport: ZoomSize): ZoomView {
  return {
    ...view,
    x: clampAxis(view.x, image.width * view.scale, viewport.width),
    y: clampAxis(view.y, image.height * view.scale, viewport.height),
  };
}

export function fitView(image: ZoomSize, viewport: ZoomSize): ZoomView {
  return clampView({ scale: fitScale(image, viewport), x: 0, y: 0, fit: true }, image, viewport);
}

/** Zooms to `scale`, keeping the image point under `point` where it is. */
export function zoomTo(
  view: ZoomView,
  scale: number,
  point: ZoomPoint,
  image: ZoomSize,
  viewport: ZoomSize,
): ZoomView {
  const fit = fitScale(image, viewport);
  const next = Math.min(MAX_ZOOM, Math.max(minScale(image, viewport), scale));
  if (Math.abs(next - fit) < EPSILON) return fitView(image, viewport);
  const ratio = next / view.scale;
  return clampView(
    {
      scale: next,
      x: point.x - (point.x - view.x) * ratio,
      y: point.y - (point.y - view.y) * ratio,
      fit: false,
    },
    image,
    viewport,
  );
}

/** The next zoom stop in a direction; the fitted size is always one of them. */
export function stepScale(
  view: ZoomView,
  direction: 1 | -1,
  image: ZoomSize,
  viewport: ZoomSize,
): number {
  const stops = [...STEPS, fitScale(image, viewport)].sort((a, b) => a - b);
  if (direction > 0) return stops.find((stop) => stop > view.scale + EPSILON) ?? MAX_ZOOM;
  return stops.reverse().find((stop) => stop < view.scale - EPSILON) ?? minScale(image, viewport);
}

export function panBy(
  view: ZoomView,
  dx: number,
  dy: number,
  image: ZoomSize,
  viewport: ZoomSize,
): ZoomView {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, image, viewport);
}

/** Two fingers, as their spread and midpoint. */
export type ZoomPinch = { distance: number; middle: ZoomPoint };

/**
 * One pinch step: the image point under the fingers' previous midpoint follows
 * them to the new midpoint, scaled by how far they spread. Panning first and then
 * zooming around the new midpoint keeps that point exactly under the fingers.
 */
export function pinchTo(
  view: ZoomView,
  from: ZoomPinch,
  to: ZoomPinch,
  image: ZoomSize,
  viewport: ZoomSize,
): ZoomView {
  const moved = panBy(
    view,
    to.middle.x - from.middle.x,
    to.middle.y - from.middle.y,
    image,
    viewport,
  );
  if (!(from.distance > 0) || !(to.distance > 0)) return moved;
  return zoomTo(moved, moved.scale * (to.distance / from.distance), to.middle, image, viewport);
}

/** True when the image is larger than the viewport in some direction, so it can be dragged. */
export function canPan(view: ZoomView, image: ZoomSize, viewport: ZoomSize): boolean {
  return (
    image.width * view.scale > viewport.width + 0.5 ||
    image.height * view.scale > viewport.height + 0.5
  );
}

/** A click toggles between fitted and actual size (or 200% when those match). */
export function toggleAt(
  view: ZoomView,
  point: ZoomPoint,
  image: ZoomSize,
  viewport: ZoomSize,
): ZoomView {
  if (!view.fit) return fitView(image, viewport);
  const target = Math.abs(view.scale - 1) < EPSILON ? 2 : 1;
  return zoomTo(view, target, point, image, viewport);
}

export function zoomPercent(view: ZoomView): number {
  return Math.round(view.scale * 100);
}
