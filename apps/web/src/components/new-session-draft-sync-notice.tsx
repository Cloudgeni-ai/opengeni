/** A stale background save must never interrupt an explicit Send. */
export function NewSessionDraftSyncNotice() {
  return (
    <p role="status" className="mt-2 px-1 text-og-xs text-og-status-failed">
      Draft not saved. Send it or copy it before leaving.
    </p>
  );
}
