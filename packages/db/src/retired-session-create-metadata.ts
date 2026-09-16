const key = "_opengeni_session_create_host_delegations_v1";

/** New creates cannot write a retired authority-selection identity. */
export function withoutRetiredSessionCreateMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...metadata };
  delete next[key];
  return next;
}

/** Historical nonempty or malformed selections must not replay as native creates. */
export function hasRetiredSessionCreateSelection(metadata: Record<string, unknown>): boolean {
  const value = metadata[key];
  return value != null && !(Array.isArray(value) && value.length === 0);
}
