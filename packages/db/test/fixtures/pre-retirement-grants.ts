import postgres from "postgres";
import {
  SUBSCRIPTION_CODEX_TWIN_PRIVATE_ROUTINES,
  SUBSCRIPTION_RENAMED_ROUTINES,
  SUBSCRIPTION_RETIRED_ROUTINES,
} from "../../src/runtime-posture";

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const TWINS = new Set<string>(SUBSCRIPTION_CODEX_TWIN_PRIVATE_ROUTINES);

/**
 * Restores, after provisionRoles, the runtime grants the last release before
 * the drained retirement migration (0721) gave the objects 0721 retires. This
 * release's provision-roles names no retired object, so a test database that
 * models the window before 0721 (the retirement held back) calls this to
 * stand where that release left it:
 * - the runtime role executes the SuperGrok and Claude pool routines and
 *   PUBLIC does not (0234 granted the SuperGrok ones itself; only
 *   provision-roles granted the Claude ones);
 * - the Codex connection target, auto-assignment apply routine, writer
 *   context and Codex-named trigger functions stay owner-only.
 * The Codex twins need nothing: provision-roles' schema-wide grant on
 * opengeni_private already lets the runtime role execute them.
 */
export async function restorePreRetirementGrants(
  adminUrl: string,
  { role = "opengeni_app", schema = "public" }: { role?: string; schema?: string } = {},
): Promise<void> {
  const executable = SUBSCRIPTION_RETIRED_ROUTINES.filter(
    // The pool routines, not their trigger functions.
    ({ schema: home, signature }) => home === "target" && !signature.endsWith("()"),
  ).map(({ signature }) => `${identifier(schema)}.${signature}`);
  const ownerOnly = [
    ...SUBSCRIPTION_RETIRED_ROUTINES.filter(
      ({ schema: home, signature }) =>
        home !== "target" && !TWINS.has(signature) && !signature.endsWith("()"),
    ).map(({ schema: home, signature }) => `${home}.${signature}`),
    ...SUBSCRIPTION_RENAMED_ROUTINES.map(({ schema: home, from }) => `${home}.${from}`),
  ];
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  const present = async (routine: string) => {
    const [row] = await admin<{ present: boolean }[]>`
      select to_regprocedure(${routine}) is not null as present`;
    return row?.present === true;
  };
  try {
    for (const routine of executable) {
      if (!(await present(routine))) continue;
      await admin.unsafe(`REVOKE ALL ON FUNCTION ${routine} FROM PUBLIC`);
      await admin.unsafe(`GRANT EXECUTE ON FUNCTION ${routine} TO ${identifier(role)}`);
    }
    for (const routine of ownerOnly) {
      if (!(await present(routine))) continue;
      await admin.unsafe(`REVOKE EXECUTE ON FUNCTION ${routine} FROM ${identifier(role)}`);
    }
  } finally {
    await admin.end();
  }
}
