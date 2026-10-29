/**
 * The person behind a stored principal or attribution: `user:<subject>`,
 * where the subject is itself `user:<id>`. Site Data owners and Site viewer
 * ids keep that documented form; older rig attributions were written the same
 * way, newer ones are the subject itself. Null for anything that isn't a person.
 */
export function personSubjectOf(value: string | null | undefined): string | null {
  if (!value?.startsWith("user:")) return null;
  const rest = value.slice("user:".length);
  if (rest.startsWith("user:")) return rest.length > "user:".length ? rest : null;
  // Another kind behind "user:" (an API key's "service:<id>") isn't a person.
  if (/^[a-z][a-z_-]*:/u.test(rest)) return null;
  return rest ? value : null;
}
