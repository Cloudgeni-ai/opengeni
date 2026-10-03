/**
 * A padlock drawn locally. Importing lucide's LockIcon here would share a
 * module with the session route's private-chat header and reshuffle the
 * session graph's chunks; this keeps Insights out of that graph.
 */
export function LockGlyph(props: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
