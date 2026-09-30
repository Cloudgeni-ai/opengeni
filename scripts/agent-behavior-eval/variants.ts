/**
 * A variant shapes how the harness creates sessions, so one scenario set can
 * compare agent configurations. Adding one is a small change:
 *
 *   1. add an entry to VARIANTS with a `shapeCreateRequest` that edits the
 *      create-session body (e.g. `{ ...request, agent: { capabilities: "all" } }`);
 *   2. optionally list `scenarios` to restrict it (e.g. "none"-only scenarios);
 *   3. run `bun run eval:behavior -- --variants legacy,<id>`.
 *
 * `legacy` sends exactly what a product client sends today (no agent config),
 * so it measures the current prompt and tool surface.
 */
export type VariantScenario = { id: string };

export type Variant = {
  id: string;
  description: string;
  /** Returns the create-session request body for one scenario session. */
  shapeCreateRequest: (
    request: Record<string, unknown>,
    scenario: VariantScenario,
  ) => Record<string, unknown>;
  /** Optional scenario allow-list; omitted = every scenario. */
  scenarios?: string[];
};

export const VARIANTS: Record<string, Variant> = {
  legacy: {
    id: "legacy",
    description: "Current behavior: sessions created without any agent configuration.",
    shapeCreateRequest: (request) => request,
  },
};

export function selectVariants(filter: string | undefined): Variant[] {
  const ids = (filter ?? "legacy")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return ids.map((id) => {
    const variant = VARIANTS[id];
    if (!variant) {
      throw new Error(`unknown variant "${id}" (known: ${Object.keys(VARIANTS).join(", ")})`);
    }
    return variant;
  });
}
