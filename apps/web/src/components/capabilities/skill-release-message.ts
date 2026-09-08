import type { SkillSourceReleaseReceipt } from "@opengeni/sdk";

/** Source removal and removal of customized instructions are different outcomes. */
export function skillReleaseMessage(
  releases: readonly SkillSourceReleaseReceipt[] | undefined,
): string | undefined {
  const kept = releases?.filter((receipt) => receipt.disposition === "preserved").length ?? 0;
  if (!kept) return undefined;
  return kept === 1
    ? "The source was removed, but your customized or re-scoped Skill remains active."
    : `The source was removed, but ${kept} customized or re-scoped Skills remain active.`;
}
