import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { useOpenGeniText } from "../messages/runtime";

type ConversationRenderBoundaryProps = {
  /** A change (another session or workspace) clears a previous failure. */
  resetKey: string;
  children: ReactNode;
};

type BoundaryState = { failed: boolean; resetKey: string };

/**
 * Contains a rendering error inside the chat. Without it, one bad payload or
 * an incompatible host response unmounts the whole embedding page (a blank
 * Site or dashboard). Try again remounts the chat with fresh data.
 */
export function ConversationRenderBoundary({
  resetKey,
  children,
}: ConversationRenderBoundaryProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <Boundary resetKey={`${resetKey}:${attempt}`} onRetry={() => setAttempt((value) => value + 1)}>
      {children}
    </Boundary>
  );
}

class Boundary extends Component<
  { resetKey: string; onRetry: () => void; children: ReactNode },
  BoundaryState
> {
  state: BoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("Opengeni chat failed to render", error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? (
      <ConversationRenderError onRetry={this.props.onRetry} />
    ) : (
      this.props.children
    );
  }
}

function ConversationRenderError({ onRetry }: { onRetry: () => void }) {
  const t = useOpenGeniText();
  return (
    <div
      role="alert"
      data-og-conversation-render-error=""
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center"
    >
      <p className="max-w-sm text-og-base text-og-fg-muted">
        {t("conversationRenderBoundary.chatUnavailable")}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-9 items-center rounded-og-md border border-og-border bg-og-surface-1 px-3 py-1.5 text-og-sm font-medium text-og-fg hover:bg-og-surface-2"
      >
        {t("conversationRenderBoundary.tryAgain")}
      </button>
    </div>
  );
}
