import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { unresolvedCodexCredentialFailures } from "../src/codex-failure-eligibility";

const recovered = {
  id: "a",
  status: "active",
  exhaustedUntil: null,
  exhaustedKind: null,
  exhaustedRevision: 4,
};
const metadata = {
  codexCredentialFailedIds: ["a"],
  codexCredentialFailureCooldownRevisions: { a: 3 },
};

describe("same-turn definitive failure recovery", () => {
  test("status quarantine does not acquire a new pre-0383 column dependency", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const quarantine = source.slice(
      source.indexOf("export async function quarantineCodexCredentialForLease("),
    );
    const credentialRead = quarantine.slice(
      quarantine.indexOf("const [credential] = await tx"),
      quarantine.indexOf("if (!credential)"),
    );
    expect(credentialRead).toMatch(
      /exhaustedRevision:\s*input\.quarantine\.kind === "cooldown"\s*\? schema\.codexSubscriptionCredentials\.exhaustedRevision\s*: sql<number>`0`/u,
    );
  });

  test("a newer cleared cooldown releases selection, not the failure ledger", () => {
    expect(unresolvedCodexCredentialFailures(metadata, [recovered])).toEqual([]);
    expect(metadata.codexCredentialFailedIds).toEqual(["a"]);
    expect(
      unresolvedCodexCredentialFailures(metadata, [{ ...recovered, exhaustedRevision: 3 }]),
    ).toEqual(["a"]);
  });

  test("legacy failures cannot use an unrelated older cooldown clear as recovery", () => {
    const legacy = { codexCredentialFailedIds: ["a"] };
    expect(unresolvedCodexCredentialFailures(legacy, [recovered])).toEqual(["a"]);
    for (const exhaustedRevision of [0, 1, NaN]) {
      expect(
        unresolvedCodexCredentialFailures(legacy, [{ ...recovered, exhaustedRevision }]),
      ).toEqual(["a"]);
    }
  });

  test("healthy-looking cache, expired backpressure, and newer refusals do not recover", () => {
    for (const account of [
      { ...recovered, exhaustedRevision: 3 },
      { ...recovered, exhaustedKind: "rate_limit", exhaustedUntil: new Date(0) },
      { ...recovered, exhaustedKind: "quota", exhaustedUntil: new Date("2100-01-01") },
      { ...recovered, status: "needs_relogin" },
    ]) {
      expect(unresolvedCodexCredentialFailures(metadata, [account])).toEqual(["a"]);
    }
  });

  test("status failures and malformed revision receipts fail closed", () => {
    for (const a of [null, "3", -1, NaN]) {
      expect(
        unresolvedCodexCredentialFailures(
          {
            ...metadata,
            codexCredentialFailureCooldownRevisions: { a },
          },
          [recovered],
        ),
      ).toEqual(["a"]);
    }
    expect(unresolvedCodexCredentialFailures(metadata, [])).toEqual(["a"]);
  });

  test("a repeated refusal updates the fence and requires another real recovery", () => {
    const second = { ...metadata, codexCredentialFailureCooldownRevisions: { a: 5 } };
    expect(unresolvedCodexCredentialFailures(second, [recovered])).toEqual(["a"]);
    expect(
      unresolvedCodexCredentialFailures(second, [{ ...recovered, exhaustedRevision: 6 }]),
    ).toEqual([]);
  });
});
