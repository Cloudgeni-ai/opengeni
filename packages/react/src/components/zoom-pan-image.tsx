import { MinusIcon, PlusIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from "react";

import { cn } from "../lib/cn";
import {
  canPan,
  clampView,
  fitView,
  MAX_ZOOM,
  minScale,
  panBy,
  stepScale,
  toggleAt,
  zoomPercent,
  zoomTo,
  type ZoomPoint,
  type ZoomSize,
  type ZoomView,
} from "../lib/zoom-pan";
import { Button } from "../ui/button";

type ZoomState = {
  key: string;
  image: ZoomSize | null;
  viewport: ZoomSize | null;
  view: ZoomView | null;
};

export type ZoomPanController = {
  /** Null until both the image's pixel size and the viewport are known. */
  view: ZoomView | null;
  image: ZoomSize | null;
  viewport: ZoomSize | null;
  percent: number | null;
  canZoomIn: boolean;
  canZoomOut: boolean;
  setImage(size: ZoomSize): void;
  setViewport(size: ZoomSize): void;
  zoomIn(point?: ZoomPoint): void;
  zoomOut(point?: ZoomPoint): void;
  zoomBy(factor: number, point: ZoomPoint): void;
  fit(): void;
  toggleAt(point: ZoomPoint): void;
  panBy(dx: number, dy: number): void;
};

function validSize(size: ZoomSize | null | undefined): size is ZoomSize {
  return !!size && size.width > 0 && size.height > 0;
}

function settle(state: ZoomState): ZoomState {
  if (!validSize(state.image) || !validSize(state.viewport)) return { ...state, view: null };
  if (!state.view || state.view.fit)
    return { ...state, view: fitView(state.image, state.viewport) };
  return { ...state, view: clampView(state.view, state.image, state.viewport) };
}

/**
 * Zoom and pan state for one image. A new `resetKey` (the next artifact or
 * screenshot) starts again from fitted, so zoom never carries over.
 */
export function useZoomPan(resetKey: string): ZoomPanController {
  const [stored, setStored] = useState<ZoomState>({
    key: resetKey,
    image: null,
    viewport: null,
    view: null,
  });
  const state: ZoomState =
    stored.key === resetKey
      ? stored
      : { key: resetKey, image: null, viewport: stored.viewport, view: null };
  if (stored.key !== resetKey) setStored(state);
  const key = useRef(resetKey);
  key.current = resetKey;

  const update = useCallback((change: (current: ZoomState) => ZoomState) => {
    setStored((current) =>
      change(
        current.key === key.current
          ? current
          : { key: key.current, image: null, viewport: current.viewport, view: null },
      ),
    );
  }, []);
  const move = useCallback(
    (change: (view: ZoomView, image: ZoomSize, viewport: ZoomSize) => ZoomView) =>
      update((current) =>
        current.view && current.image && current.viewport
          ? { ...current, view: change(current.view, current.image, current.viewport) }
          : current,
      ),
    [update],
  );

  const { image, viewport, view } = state;
  return useMemo<ZoomPanController>(() => {
    const centre = (size: ZoomSize | null): ZoomPoint =>
      size ? { x: size.width / 2, y: size.height / 2 } : { x: 0, y: 0 };
    return {
      view,
      image,
      viewport,
      percent: view ? zoomPercent(view) : null,
      canZoomIn: !!view && view.scale < MAX_ZOOM - 0.001,
      canZoomOut: !!view && !!image && !!viewport && view.scale > minScale(image, viewport) + 0.001,
      setImage: (size) =>
        update((current) =>
          validSize(size) &&
          (current.image?.width !== size.width || current.image?.height !== size.height)
            ? settle({ ...current, image: size, view: null })
            : current,
        ),
      setViewport: (size) =>
        update((current) =>
          validSize(size) &&
          (current.viewport?.width !== size.width || current.viewport?.height !== size.height)
            ? settle({ ...current, viewport: size })
            : current,
        ),
      zoomIn: (point) =>
        move((current, img, port) =>
          zoomTo(current, stepScale(current, 1, img, port), point ?? centre(port), img, port),
        ),
      zoomOut: (point) =>
        move((current, img, port) =>
          zoomTo(current, stepScale(current, -1, img, port), point ?? centre(port), img, port),
        ),
      zoomBy: (factor, point) =>
        move((current, img, port) => zoomTo(current, current.scale * factor, point, img, port)),
      fit: () => move((_current, img, port) => fitView(img, port)),
      toggleAt: (point) => move((current, img, port) => toggleAt(current, point, img, port)),
      panBy: (dx, dy) => move((current, img, port) => panBy(current, dx, dy, img, port)),
    };
  }, [image, viewport, view, update, move]);
}

/** Which zoom a key press asks for: Cmd/Ctrl with plus, minus or zero. */
export function zoomShortcut(event: KeyboardEvent): "in" | "out" | "fit" | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  switch (event.key) {
    case "=":
    case "+":
      return "in";
    case "-":
    case "_":
      return "out";
    case "0":
      return "fit";
  }
  switch (event.code) {
    case "Equal":
    case "NumpadAdd":
      return "in";
    case "Minus":
    case "NumpadSubtract":
      return "out";
    case "Digit0":
    case "Numpad0":
      return "fit";
  }
  return null;
}

function editable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select") !== null)
  );
}

/**
 * While an image is on screen, Cmd/Ctrl + plus, minus and zero zoom the image
 * instead of the page or the desktop window. The listener runs first and
 * claims the key, so the browser's and the desktop menu's zoom never see it;
 * elsewhere in the app they work as usual.
 */
export function useZoomPanShortcuts(controller: ZoomPanController, enabled: boolean) {
  const latest = useRef(controller);
  latest.current = controller;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const action = zoomShortcut(event);
      if (!action || editable(event.target)) return;
      // Claimed even before the image has loaded, so the window never zooms instead.
      event.preventDefault();
      event.stopPropagation();
      if (!latest.current.view) return;
      if (action === "in") latest.current.zoomIn();
      else if (action === "out") latest.current.zoomOut();
      else latest.current.fit();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [enabled]);
}

/** A drag shorter than this is still a click. */
const CLICK_SLOP = 4;

type Gesture = {
  moved: boolean;
  start: ZoomPoint;
  pinch: { distance: number; middle: ZoomPoint } | null;
};

function distance(a: ZoomPoint, b: ZoomPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function middle(a: ZoomPoint, b: ZoomPoint): ZoomPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Normalises a wheel delta to pixels (line and page modes come from mouse wheels). */
function wheelPixels(event: WheelEvent, delta: number) {
  return event.deltaMode === 1 ? delta * 16 : event.deltaMode === 2 ? delta * 400 : delta;
}

/**
 * An image that fills its (positioned) parent, fitted and centred, and can be
 * zoomed and panned: click toggles fitted and actual size at the click point,
 * Cmd/Ctrl + wheel and trackpad or touch pinch zoom around the pointer, and a
 * drag or plain scroll pans a zoomed image. The image is laid out at its
 * zoomed pixel size (not a CSS transform scale), so it stays sharp.
 */
export function ZoomPanSurface({
  controller,
  src,
  alt,
  naturalSize,
  onBackdropClick,
  onError,
  className,
  imageClassName,
  labels,
}: {
  controller: ZoomPanController;
  src: string;
  alt: string;
  /** The image's pixel size when known up front, so it is laid out before it loads. */
  naturalSize?: ZoomSize | null | undefined;
  /** A click beside a fitted image, such as closing a lightbox. */
  onBackdropClick?: (() => void) | undefined;
  onError?: ((event: SyntheticEvent<HTMLImageElement>) => void) | undefined;
  className?: string | undefined;
  imageClassName?: string | undefined;
  labels?: { zoomIn?: string; fit?: string } | undefined;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const latest = useRef(controller);
  latest.current = controller;
  const pointers = useRef(new Map<number, ZoomPoint>());
  const gesture = useRef<Gesture | null>(null);
  const [dragging, setDragging] = useState(false);
  const { view, image, viewport } = controller;

  const local = useCallback((event: { clientX: number; clientY: number }): ZoomPoint => {
    const rect = surface.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }, []);

  const knownWidth = naturalSize?.width ?? 0;
  const knownHeight = naturalSize?.height ?? 0;
  useEffect(() => {
    if (knownWidth > 0 && knownHeight > 0)
      latest.current.setImage({ width: knownWidth, height: knownHeight });
  }, [knownWidth, knownHeight]);

  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0)
        latest.current.setViewport({ width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Wheel and Safari's trackpad gestures need non-passive listeners to claim them.
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const current = latest.current;
      if (!current.view || !current.image || !current.viewport) return;
      if (event.ctrlKey || event.metaKey) {
        // Ctrl + wheel is also how browsers report a trackpad pinch.
        event.preventDefault();
        const delta = Math.max(-60, Math.min(60, wheelPixels(event, event.deltaY)));
        current.zoomBy(Math.exp(-delta * 0.006), local(event));
        return;
      }
      if (!canPan(current.view, current.image, current.viewport)) return;
      event.preventDefault();
      const dx = wheelPixels(event, event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX);
      const dy = event.shiftKey && !event.deltaX ? 0 : wheelPixels(event, event.deltaY);
      current.panBy(-dx, -dy);
    };
    let gestureScale = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureScale = 1;
    };
    const onGestureChange = (event: Event) => {
      const scale = (event as Event & { scale?: number }).scale;
      const point = event as Event & { clientX?: number; clientY?: number };
      if (typeof scale !== "number" || scale <= 0) return;
      event.preventDefault();
      latest.current.zoomBy(
        scale / gestureScale,
        local({ clientX: point.clientX ?? 0, clientY: point.clientY ?? 0 }),
      );
      gestureScale = scale;
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("gesturestart", onGestureStart, { passive: false });
    element.addEventListener("gesturechange", onGestureChange, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("gesturestart", onGestureStart);
      element.removeEventListener("gesturechange", onGestureChange);
    };
  }, [local]);

  const insideImage = (point: ZoomPoint) =>
    !!view &&
    !!image &&
    point.x >= view.x &&
    point.y >= view.y &&
    point.x <= view.x + image.width * view.scale &&
    point.y <= view.y + image.height * view.scale;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Not every environment can capture this pointer; dragging still works inside.
    }
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    const points = [...pointers.current.values()];
    if (points.length === 1) gesture.current = { moved: false, start: point, pinch: null };
    else if (points.length === 2 && gesture.current) {
      gesture.current.moved = true;
      gesture.current.pinch = {
        distance: distance(points[0]!, points[1]!),
        middle: middle(points[0]!, points[1]!),
      };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    const current = gesture.current;
    if (!previous || !current) return;
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    const points = [...pointers.current.values()];
    if (points.length >= 2 && current.pinch) {
      const nextDistance = distance(points[0]!, points[1]!);
      const nextMiddle = middle(points[0]!, points[1]!);
      if (current.pinch.distance > 0)
        controller.zoomBy(nextDistance / current.pinch.distance, nextMiddle);
      controller.panBy(
        nextMiddle.x - current.pinch.middle.x,
        nextMiddle.y - current.pinch.middle.y,
      );
      current.pinch = { distance: nextDistance, middle: nextMiddle };
      return;
    }
    if (!current.moved && distance(point, current.start) > CLICK_SLOP) current.moved = true;
    if (current.moved && view && image && viewport && canPan(view, image, viewport)) {
      setDragging(true);
      controller.panBy(point.x - previous.x, point.y - previous.y);
    }
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const current = gesture.current;
    if (pointers.current.size > 0) {
      // One finger of a pinch lifted: the other keeps panning, never clicks.
      if (current) current.pinch = null;
      return;
    }
    gesture.current = null;
    setDragging(false);
    if (event.type !== "pointerup" || !current || current.moved) return;
    const point = local(event);
    if (onBackdropClick && (!view || view.fit) && !insideImage(point)) onBackdropClick();
    else if (view) controller.toggleAt(point);
  };

  const pannable = !!view && !!image && !!viewport && canPan(view, image, viewport);
  const zoomedOut = !!view && view.fit;
  return (
    <div
      ref={surface}
      data-zoom-pan-surface
      role="presentation"
      title={zoomedOut ? labels?.zoomIn : pannable ? undefined : labels?.fit}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      className={cn(
        "absolute inset-0 touch-none overflow-hidden select-none",
        dragging
          ? "cursor-grabbing"
          : pannable
            ? "cursor-grab"
            : zoomedOut
              ? "cursor-zoom-in"
              : "cursor-zoom-out",
        className,
      )}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        data-zoom-scale={view ? view.scale.toFixed(3) : undefined}
        onLoad={(event) => {
          const element = event.currentTarget;
          if (element.naturalWidth > 0 && element.naturalHeight > 0)
            controller.setImage({ width: element.naturalWidth, height: element.naturalHeight });
        }}
        onError={onError}
        style={
          view && image
            ? {
                position: "absolute",
                left: 0,
                top: 0,
                width: image.width * view.scale,
                height: image.height * view.scale,
                maxWidth: "none",
                maxHeight: "none",
                // Whole pixels, so an image at actual size is never resampled.
                transform: `translate3d(${Math.round(view.x)}px, ${Math.round(view.y)}px, 0)`,
                // Past 2x, show the screenshot's own pixels crisply instead of blurring them.
                imageRendering: view.scale >= 2 ? "pixelated" : undefined,
              }
            : undefined
        }
        className={cn(
          "pointer-events-none block",
          !view && "absolute inset-0 m-auto max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)]",
          imageClassName,
        )}
      />
    </div>
  );
}

function shortcutModifier() {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad/u.test(navigator.platform) ? "⌘" : "Ctrl";
}

export type ZoomControlLabels = {
  zoomIn?: string | undefined;
  zoomOut?: string | undefined;
  fit?: string | undefined;
};

/** Zoom out, the zoom percentage, zoom in and Fit, for a header or caption. */
export function ZoomControls({
  controller,
  labels,
  className,
  buttonClassName,
}: {
  controller: ZoomPanController;
  labels?: ZoomControlLabels | undefined;
  className?: string | undefined;
  buttonClassName?: string | undefined;
}) {
  const modifier = useMemo(shortcutModifier, []);
  const zoomOut = labels?.zoomOut ?? "Zoom out";
  const zoomIn = labels?.zoomIn ?? "Zoom in";
  const fit = labels?.fit ?? "Fit";
  const { view } = controller;
  return (
    <div data-zoom-controls className={cn("flex shrink-0 items-center gap-0.5", className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn("pointer-coarse:size-11", buttonClassName)}
        aria-label={zoomOut}
        title={`${zoomOut} (${modifier}−)`}
        disabled={!controller.canZoomOut}
        onClick={() => controller.zoomOut()}
      >
        <MinusIcon aria-hidden="true" />
      </Button>
      <span data-zoom-percent className="min-w-11 text-center text-xs tabular-nums opacity-80">
        {controller.percent === null ? "" : `${controller.percent}%`}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn("pointer-coarse:size-11", buttonClassName)}
        aria-label={zoomIn}
        title={`${zoomIn} (${modifier}+)`}
        disabled={!controller.canZoomIn}
        onClick={() => controller.zoomIn()}
      >
        <PlusIcon aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn("h-8 px-2 text-xs pointer-coarse:h-11", buttonClassName)}
        title={`${fit} (${modifier}0)`}
        disabled={!view || view.fit}
        onClick={() => controller.fit()}
      >
        {fit}
      </Button>
    </div>
  );
}
