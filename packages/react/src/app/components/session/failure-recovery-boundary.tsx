import { Component, type ReactNode } from "react";
import { LoadFailureNotice } from "../../../components/load-failure-notice";
import { isChunkLoadError } from "../../../lib/chunk-load-error";

/**
 * A failed recovery-options chunk must never take the conversation down. The
 * plain fallback still shows; when the chunk didn't download, so does Reload.
 */
export class FailureRecoveryBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean; notLoaded: boolean }
> {
  state = { failed: false, notLoaded: false };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, notLoaded: isChunkLoadError(error) };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return this.state.notLoaded ? (
      <>
        {this.props.fallback}
        <LoadFailureNotice />
      </>
    ) : (
      this.props.fallback
    );
  }
}
