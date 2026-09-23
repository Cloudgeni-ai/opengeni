/** Reserve the same row geometry as the loaded connection list. */
export function ConnectionSkeleton({ rows = 1, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="og-connection-skeleton">
      {Array.from({ length: rows }, (_, index) => (
        <div className="og-connection-skeleton-row" aria-hidden="true" key={index}>
          <span className="og-connection-skeleton-mark" />
          <span className="og-connection-skeleton-copy">
            <span />
            <span />
          </span>
        </div>
      ))}
    </div>
  );
}
