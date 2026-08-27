import { PaperclipIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";

function carriesFiles(event: { dataTransfer: DataTransfer | null }): boolean {
  return event.dataTransfer !== null && [...event.dataTransfer.types].includes("Files");
}

export function ChatViewportFileDropTarget({
  children,
  enabled,
  onFiles,
  className,
}: {
  children: ReactNode;
  enabled: boolean;
  onFiles: (files: FileList) => void;
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const reset = useCallback(() => {
    dragDepth.current = 0;
    setDragging(false);
  }, []);

  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  useEffect(() => {
    if (!dragging) return;
    globalThis.addEventListener("dragend", reset);
    globalThis.addEventListener("drop", reset);
    globalThis.addEventListener("blur", reset);
    return () => {
      globalThis.removeEventListener("dragend", reset);
      globalThis.removeEventListener("drop", reset);
      globalThis.removeEventListener("blur", reset);
    };
  }, [dragging, reset]);

  const onDragEnter = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !carriesFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    [enabled],
  );

  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    [enabled],
  );

  const onDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || dragDepth.current === 0) return;
      event.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    [enabled],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const handledByChild = event.defaultPrevented;
      const dataTransfer = event.dataTransfer;
      const files = dataTransfer && carriesFiles(event) ? dataTransfer.files : null;
      reset();
      if (!enabled || !files) return;
      event.preventDefault();
      if (!handledByChild && files.length > 0) onFiles(files);
    },
    [enabled, onFiles, reset],
  );

  return (
    <section
      data-workspace-scroll-owner="self-managed"
      data-testid="chat-viewport-drop-target"
      className={cn("relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden", className)}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
      {dragging ? (
        <div
          aria-hidden="true"
          data-testid="chat-viewport-drop-overlay"
          className="pointer-events-none absolute inset-0 z-40 grid place-items-center border-2 border-brand/70 bg-brand/15 text-brand backdrop-blur-[1px]"
        >
          <span className="inline-flex items-center gap-2 rounded-lg border border-brand/40 bg-surface/90 px-4 py-3 text-sm font-medium shadow-lg">
            <PaperclipIcon className="size-4" />
            Drop files to attach
          </span>
        </div>
      ) : null}
    </section>
  );
}
