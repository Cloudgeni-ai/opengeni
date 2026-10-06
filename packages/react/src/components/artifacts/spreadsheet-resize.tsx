import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "../../lib/cn";

export type SpreadsheetDimensionAxis = "row" | "column";

/** One pixel dimension change, committed after a drag or keyboard gesture. */
export type SpreadsheetDimensionCommit = {
  sheetId: string;
  axis: SpreadsheetDimensionAxis;
  index: number;
  size: number;
};

const MIN_SIZE = 8;
const MAX_SIZE = 4_096;

type ResizePreview = SpreadsheetDimensionCommit & {
  id: number;
  baseRevision: string | number;
  settled: boolean;
};

type Gesture = SpreadsheetDimensionCommit & {
  startSize: number;
  startPosition: number;
  pointerId: number | null;
};

type ResizeOptions = {
  sheetId: string;
  generationId: string | null;
  revision: string | number;
  rowHeights: readonly (readonly [number, number])[];
  columnWidths: readonly (readonly [number, number])[];
  defaultRowHeight: number;
  defaultColumnWidth: number;
  enabled: boolean;
  commit?: ((change: SpreadsheetDimensionCommit) => void | Promise<void>) | undefined;
  onCommandError?: ((error: Error) => void) | undefined;
  onStart?: (() => void) | undefined;
};

function keyOf(change: Pick<SpreadsheetDimensionCommit, "axis" | "index">): string {
  return `${change.axis}:${change.index}`;
}

function boundedSize(size: number): number {
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(size)));
}

/** Transient gesture/pending previews only; the caller owns durable dimensions. */
export function useSpreadsheetResizing(options: ResizeOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [pending, setPending] = useState<readonly ResizePreview[]>([]);
  const [inFlightCount, setInFlightCount] = useState(0);
  const [errors, setErrors] = useState<
    readonly { key: string; message: string; retry: () => void }[]
  >([]);
  const errorsRef = useRef(new Map<string, { key: string; message: string; retry: () => void }>());
  const activeRef = useRef<Gesture | null>(null);
  const pendingRef = useRef(new Map<string, ResizePreview>());
  const frameRef = useRef<number | null>(null);
  const nextIdRef = useRef(0);
  const scopeRef = useRef(0);
  const mountedRef = useRef(true);

  const clearError = useCallback(() => {
    errorsRef.current.clear();
    setErrors([]);
  }, []);
  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) globalThis.cancelAnimationFrame?.(frameRef.current);
    frameRef.current = null;
  }, []);
  const cancel = useCallback(() => {
    cancelFrame();
    activeRef.current = null;
    setGesture(null);
  }, [cancelFrame]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scopeRef.current += 1;
      cancelFrame();
    };
  }, [cancelFrame]);

  useEffect(() => {
    scopeRef.current += 1;
    cancel();
    pendingRef.current.clear();
    setPending([]);
    setInFlightCount(0);
    clearError();
  }, [cancel, clearError, options.enabled, options.generationId, options.sheetId]);

  const authoritativeSize = useCallback((axis: SpreadsheetDimensionAxis, index: number) => {
    const current = optionsRef.current;
    const entries = axis === "row" ? current.rowHeights : current.columnWidths;
    return (
      entries.find(([at]) => at === index)?.[1] ??
      (axis === "row" ? current.defaultRowHeight : current.defaultColumnWidth)
    );
  }, []);

  useEffect(() => {
    let changed = false;
    for (const [key, entry] of pendingRef.current) {
      if (
        entry.settled &&
        (authoritativeSize(entry.axis, entry.index) === entry.size ||
          options.revision !== entry.baseRevision)
      ) {
        pendingRef.current.delete(key);
        changed = true;
      }
    }
    if (changed) setPending([...pendingRef.current.values()]);
  }, [authoritativeSize, options.columnWidths, options.revision, options.rowHeights, pending]);

  const submit = useCallback((change: SpreadsheetDimensionCommit): void => {
    const current = optionsRef.current;
    if (!current.enabled || !current.commit || change.sheetId !== current.sheetId) return;
    const scope = scopeRef.current;
    const id = ++nextIdRef.current;
    const key = keyOf(change);
    const entry: ResizePreview = { ...change, id, baseRevision: current.revision, settled: false };
    pendingRef.current.set(key, entry);
    setPending([...pendingRef.current.values()]);
    errorsRef.current.delete(key);
    setErrors([...errorsRef.current.values()]);
    current.onStart?.();
    let asynchronous = false;
    const settle = (failed: boolean, cause?: unknown) => {
      if (!mountedRef.current || scopeRef.current !== scope) return;
      if (asynchronous) setInFlightCount((count) => Math.max(0, count - 1));
      const latest = pendingRef.current.get(key);
      if (latest?.id !== id) return;
      if (failed) {
        pendingRef.current.delete(key);
        const failure = cause instanceof Error ? cause : new Error(String(cause));
        errorsRef.current.set(key, {
          key,
          message: failure.message || "Spreadsheet resize failed",
          retry: () => {
            if (!mountedRef.current || scopeRef.current !== scope) return;
            submit(change);
          },
        });
        setErrors([...errorsRef.current.values()]);
        optionsRef.current.onCommandError?.(failure);
      } else {
        pendingRef.current.set(key, {
          ...entry,
          baseRevision: optionsRef.current.revision,
          settled: true,
        });
      }
      setPending([...pendingRef.current.values()]);
    };
    try {
      const result = current.commit(change);
      if (result && typeof result.then === "function") {
        asynchronous = true;
        setInFlightCount((count) => count + 1);
        void Promise.resolve(result).then(
          () => settle(false),
          (cause) => settle(true, cause),
        );
      } else {
        settle(false);
      }
    } catch (cause) {
      settle(true, cause);
    }
  }, []);

  const update = useCallback((next: Gesture) => {
    activeRef.current = next;
    if (frameRef.current !== null) return;
    if (typeof globalThis.requestAnimationFrame !== "function") {
      setGesture(next);
      return;
    }
    frameRef.current = globalThis.requestAnimationFrame(() => {
      frameRef.current = null;
      if (mountedRef.current) setGesture(activeRef.current);
    });
  }, []);

  const finish = useCallback(() => {
    const active = activeRef.current;
    cancel();
    if (!active || active.size === active.startSize) return;
    submit({ sheetId: active.sheetId, axis: active.axis, index: active.index, size: active.size });
  }, [cancel, submit]);

  const begin = useCallback(
    (axis: SpreadsheetDimensionAxis, index: number, pointerId: number | null, position: number) => {
      const current = optionsRef.current;
      if (!current.enabled || !current.commit) return;
      const existing = pendingRef.current.get(keyOf({ axis, index }));
      const size = existing?.size ?? authoritativeSize(axis, index);
      cancel();
      const next: Gesture = {
        sheetId: current.sheetId,
        axis,
        index,
        size,
        startSize: size,
        startPosition: position,
        pointerId,
      };
      activeRef.current = next;
      setGesture(next);
      current.onStart?.();
    },
    [authoritativeSize, cancel],
  );

  const handleProps = useCallback(
    (axis: SpreadsheetDimensionAxis, index: number) => ({
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (event.button !== 0 || event.isPrimary === false) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        begin(axis, index, event.pointerId, axis === "column" ? event.clientX : event.clientY);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        const active = activeRef.current;
        if (
          !active ||
          active.pointerId !== event.pointerId ||
          active.axis !== axis ||
          active.index !== index
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const position = axis === "column" ? event.clientX : event.clientY;
        update({
          ...active,
          size: boundedSize(active.startSize + position - active.startPosition),
        });
      },
      onPointerUp(event: PointerEvent<HTMLDivElement>) {
        const active = activeRef.current;
        if (
          !active ||
          active.pointerId !== event.pointerId ||
          active.axis !== axis ||
          active.index !== index
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const position = axis === "column" ? event.clientX : event.clientY;
        activeRef.current = {
          ...active,
          size: boundedSize(active.startSize + position - active.startPosition),
        };
        finish();
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }
      },
      onPointerCancel(event: PointerEvent<HTMLDivElement>) {
        const active = activeRef.current;
        if (active?.pointerId === event.pointerId && active.axis === axis && active.index === index)
          cancel();
        event.stopPropagation();
      },
      onLostPointerCapture(event: PointerEvent<HTMLDivElement>) {
        const active = activeRef.current;
        if (active?.pointerId === event.pointerId && active.axis === axis && active.index === index)
          cancel();
      },
      onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          finish();
          return;
        }
        const negative = axis === "column" ? "ArrowLeft" : "ArrowUp";
        const positive = axis === "column" ? "ArrowRight" : "ArrowDown";
        if (event.key !== negative && event.key !== positive && event.key !== "Home") return;
        event.preventDefault();
        if (
          activeRef.current?.pointerId !== null ||
          activeRef.current.axis !== axis ||
          activeRef.current.index !== index
        ) {
          begin(axis, index, null, 0);
        }
        const active = activeRef.current;
        if (!active) return;
        const current = optionsRef.current;
        const size =
          event.key === "Home"
            ? axis === "row"
              ? current.defaultRowHeight
              : current.defaultColumnWidth
            : active.size + (event.key === negative ? -1 : 1) * (event.shiftKey ? 1 : 8);
        update({ ...active, size: boundedSize(size) });
      },
      onKeyUp(event: KeyboardEvent<HTMLDivElement>) {
        event.stopPropagation();
        const active = activeRef.current;
        if (
          active?.axis === axis &&
          active.index === index &&
          (event.key === "Home" || event.key.startsWith("Arrow"))
        )
          finish();
      },
      onBlur() {
        const active = activeRef.current;
        if (active?.pointerId === null && active.axis === axis && active.index === index) finish();
      },
    }),
    [begin, cancel, finish, update],
  );

  const pendingRows = useMemo(() => pending.filter((entry) => entry.axis === "row"), [pending]);
  const pendingColumns = useMemo(
    () => pending.filter((entry) => entry.axis === "column"),
    [pending],
  );
  const rowGesture = gesture?.axis === "row" ? gesture : null;
  const columnGesture = gesture?.axis === "column" ? gesture : null;
  const rowHeights = useMemo(
    () => previewDimensions(options.rowHeights, pendingRows, rowGesture),
    [options.rowHeights, pendingRows, rowGesture],
  );
  const columnWidths = useMemo(
    () => previewDimensions(options.columnWidths, pendingColumns, columnGesture),
    [options.columnWidths, pendingColumns, columnGesture],
  );
  const previewKey = [
    ...pending.map((entry) => `${entry.axis}:${entry.index}:${entry.size}`),
    ...(gesture ? [`${gesture.axis}:${gesture.index}:${gesture.size}`] : []),
  ].join(";");

  return {
    rowHeights,
    columnWidths,
    previewKey,
    handleProps,
    pendingCount: inFlightCount,
    error: errors[0]
      ? { message: errors[0].message, retry: options.enabled ? errors[0].retry : undefined }
      : null,
    clearError,
  };
}

function previewDimensions(
  entries: readonly (readonly [number, number])[],
  pending: readonly ResizePreview[],
  gesture: Gesture | null,
): readonly (readonly [number, number])[] {
  if (!pending.length && !gesture) return entries;
  const projected = new Map(entries);
  for (const entry of pending) projected.set(entry.index, entry.size);
  if (gesture) projected.set(gesture.index, gesture.size);
  return [...projected.entries()];
}

export function SpreadsheetResizeHandle({
  axis,
  label,
  size,
  ...handlers
}: {
  axis: SpreadsheetDimensionAxis;
  label: string;
  size: number;
} & ReturnType<ReturnType<typeof useSpreadsheetResizing>["handleProps"]>) {
  return (
    <div
      {...handlers}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === "column" ? "vertical" : "horizontal"}
      aria-valuemin={MIN_SIZE}
      aria-valuemax={MAX_SIZE}
      aria-valuenow={size}
      aria-valuetext={`${size} pixels`}
      data-og-resize-axis={axis}
      style={{ [axis === "column" ? "right" : "bottom"]: "calc(var(--spacing) * -1)" }}
      className={cn(
        "pointer-events-auto absolute z-40 touch-none outline-hidden hover:bg-og-accent/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent",
        axis === "column"
          ? "top-0 h-full w-2 cursor-col-resize"
          : "left-0 h-2 w-full cursor-row-resize",
      )}
    />
  );
}
