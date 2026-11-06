/** Untrusted, optional diagnostics; never an authorization or version gate. */
export function observedSdkVersion(value: string | undefined): string | undefined {
  return value &&
    value.length <= 80 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : undefined;
}
