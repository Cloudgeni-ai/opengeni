import { Component, Suspense, type ReactNode } from "react";

import { isChunkLoadError } from "../lib/chunk-load-error";
import { LoadFailureNotice } from "./load-failure-notice";

/**
 * Contains a lazily loaded secondary part (message actions, an inline preview,
 * a card, a panel) so that when its code fails to download, only this part is
 * replaced and what's around it, such as the message it belongs to, stays
 * visible. `notice` shows the inline Reload notice in its place; `hide` shows
 * nothing, for small affordances that repeat on every message. Other render
 * errors are not handled here and reach the surrounding boundary as before.
 */
export function LazyPart({
  children,
  fallback = null,
  onLoadFailure = "notice",
}: {
  children: ReactNode;
  fallback?: ReactNode;
  onLoadFailure?: "notice" | "hide";
}) {
  return (
    <LazyPartBoundary onLoadFailure={onLoadFailure}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </LazyPartBoundary>
  );
}

class LazyPartBoundary extends Component<
  { onLoadFailure: "notice" | "hide"; children: ReactNode },
  { error: { value: unknown } | null }
> {
  state: { error: { value: unknown } | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: { value: unknown } } {
    return { error: { value: error } };
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    // Not a download failure: let the surrounding boundary handle it.
    if (!isChunkLoadError(error.value)) throw error.value;
    return this.props.onLoadFailure === "notice" ? <LoadFailureNotice /> : null;
  }
}
