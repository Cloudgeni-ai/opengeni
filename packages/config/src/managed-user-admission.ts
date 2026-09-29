/** Deployment admission for native human accounts; never service credentials. */
export function managedUserEmailAllowed(
  allowedUserEmails: readonly string[] | undefined,
  email: unknown,
): boolean {
  return (
    allowedUserEmails === undefined ||
    (typeof email === "string" &&
      allowedUserEmails.some((allowed) => allowed.toLowerCase() === email.trim().toLowerCase()))
  );
}
