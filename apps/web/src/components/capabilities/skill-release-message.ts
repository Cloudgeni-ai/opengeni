import type { SkillSourceReleaseReceipt, SkillWriteReceipt } from "@opengeni/sdk";

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

/** A source can be installed while its guidance still awaits approval. */
export function skillInstallationMessage(
  writes: readonly SkillWriteReceipt[] | undefined,
  releases: readonly SkillSourceReleaseReceipt[] | undefined,
): string | undefined {
  let pending = 0;
  let preserved = 0;
  for (const write of writes ?? []) {
    if (write.outcome === "pending") pending++;
    if (write.outcome === "preserved") preserved++;
  }
  const notices: string[] = [];
  if (pending)
    notices.push(
      pending === 1
        ? "1 Skill change is awaiting approval."
        : `${pending} Skill changes are awaiting approval.`,
    );
  const released = skillReleaseMessage(releases);
  if (released) notices.push(released);
  else if (preserved)
    notices.push(
      preserved === 1
        ? "Your customized Skill was preserved."
        : `${preserved} customized Skills were preserved.`,
    );
  return notices.length ? notices.join(" ") : undefined;
}
