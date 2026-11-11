/** Keeps a metadata value's footprint without asserting an unknown policy. */
export function ModelSettingsPlaceholder() {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block h-4 w-32 animate-pulse rounded bg-surface-2 align-middle"
    />
  );
}
