import { PaperclipIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type ReactNode,
} from "react";

import { cn } from "../../lib/utils";

export function carriesFiles(event: { dataTransfer: DataTransfer | null }): boolean {
  return event.dataTransfer !== null && [...event.dataTransfer.types].includes("Files");
}

/** A chat that takes files dropped elsewhere in the view around it. */
export type ChatFileDropTargetHandle = Readonly<{
  /** Attach dropped files, as a drop on the chat itself does. */
  attach: (files: FileList) => void;
  /** Show or clear the chat's drop overlay while a drag is over the other place. */
  highlight: (on: boolean) => void;
}>;

/**
 * Where a view that shows a chat beside other content (the Site view) learns
 * which chat takes the files dropped on that content. The chat's own drop
 * target registers while it accepts files.
 */
export class ChatFileDropRelay {
  #target: ChatFileDropTargetHandle | null = null;
  readonly #listeners = new Set<() => void>();

  register(target: ChatFileDropTargetHandle): () => void {
    this.#target = target;
    this.#emit();
    return () => {
      if (this.#target !== target) return;
      this.#target = null;
      this.#emit();
    };
  }

  readonly current = (): ChatFileDropTargetHandle | null => this.#target;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #emit() {
    for (const listener of this.#listeners) listener();
  }
}

const ChatFileDropRelayContext = createContext<ChatFileDropRelay | null>(null);

export function ChatFileDropRelayProvider(props: {
  relay: ChatFileDropRelay;
  children?: ReactNode;
}) {
  return (
    <ChatFileDropRelayContext.Provider value={props.relay}>
      {props.children}
    </ChatFileDropRelayContext.Provider>
  );
}

/**
 * How long a file drag counts as over this page after its last event. While a
 * drag is over the page the browser repeats dragover even with the pointer
 * still; over an embedded frame or outside the window this page hears nothing.
 */
const PAGE_DRAG_IDLE_MS = 1000;

/** Whether files are being dragged over this page (not counting embedded frames). */
export function useFileDragOverPage(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearTimeout(timer);
      setActive(false);
    };
    const over = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      setActive(true);
      clearTimeout(timer);
      timer = setTimeout(stop, PAGE_DRAG_IDLE_MS);
    };
    globalThis.addEventListener("dragenter", over);
    globalThis.addEventListener("dragover", over);
    globalThis.addEventListener("drop", stop);
    globalThis.addEventListener("dragend", stop);
    globalThis.addEventListener("blur", stop);
    return () => {
      clearTimeout(timer);
      globalThis.removeEventListener("dragenter", over);
      globalThis.removeEventListener("dragover", over);
      globalThis.removeEventListener("drop", stop);
      globalThis.removeEventListener("dragend", stop);
      globalThis.removeEventListener("blur", stop);
    };
  }, []);
  return active;
}

/**
 * Covers content beside a chat, such as a Site's preview frame, while files
 * are dragged over the page, so a drop there attaches to the chat instead of
 * going to the frame (or opening the file). Place it in a positioned parent.
 * It shows only while a chat in the same relay takes files.
 */
export function ChatFileDropCover(props: { relay: ChatFileDropRelay; enabled: boolean }) {
  const target = useSyncExternalStore(props.relay.subscribe, props.relay.current, () => null);
  const dragging = useFileDragOverPage();
  if (!props.enabled || !target || !dragging) return null;
  const over = (event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    target.highlight(true);
  };
  return (
    <div
      aria-hidden="true"
      data-testid="chat-file-drop-cover"
      className="absolute inset-0 z-50"
      onDragEnter={over}
      onDragOver={over}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        target.highlight(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const files = event.dataTransfer && carriesFiles(event) ? event.dataTransfer.files : null;
        if (files) target.attach(files);
        else target.highlight(false);
      }}
    />
  );
}

export function ChatViewportFileDropTarget({
  children,
  enabled,
  onFiles,
  className,
  "data-workspace-scroll-owner": scrollOwner,
}: {
  children: ReactNode;
  enabled: boolean;
  onFiles: (files: FileList) => void;
  className?: string | undefined;
  "data-workspace-scroll-owner": "self-managed";
}) {
  const [dragging, setDragging] = useState(false);
  // A drag over the content beside this chat whose files come here.
  const [relayed, setRelayed] = useState(false);
  const dragDepth = useRef(0);
  const relay = useContext(ChatFileDropRelayContext);
  const latestOnFiles = useRef(onFiles);
  latestOnFiles.current = onFiles;

  const reset = useCallback(() => {
    dragDepth.current = 0;
    setDragging(false);
  }, []);

  useEffect(() => {
    if (enabled) return;
    reset();
    setRelayed(false);
  }, [enabled, reset]);

  useEffect(() => {
    if (!relay || !enabled) return;
    const unregister = relay.register({
      attach: (files) => {
        setRelayed(false);
        if (files.length > 0) latestOnFiles.current(files);
      },
      highlight: setRelayed,
    });
    return () => {
      unregister();
      setRelayed(false);
    };
  }, [enabled, relay]);

  useEffect(() => {
    if (!dragging && !relayed) return;
    const clear = () => {
      reset();
      setRelayed(false);
    };
    globalThis.addEventListener("dragend", clear);
    globalThis.addEventListener("drop", clear);
    globalThis.addEventListener("blur", clear);
    return () => {
      globalThis.removeEventListener("dragend", clear);
      globalThis.removeEventListener("drop", clear);
      globalThis.removeEventListener("blur", clear);
    };
  }, [dragging, relayed, reset]);

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
      data-og-conversation=""
      data-workspace-scroll-owner={scrollOwner}
      data-testid="chat-viewport-drop-target"
      className={cn("relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden", className)}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
      {dragging || relayed ? (
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
