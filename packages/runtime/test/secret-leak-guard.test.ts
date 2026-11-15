/**
 * The secret leak guard's ledger, matching and command reading (docs/secrets.md,
 * "Keeping values out of commits"). The end-to-end behaviour on a real sandbox
 * is in secret-leak-guard-git.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { ResolvedSecretValue } from "@opengeni/contracts";
import {
  SecretLedgerIndex,
  SecretLedgerKey,
  gitLeakPlan,
  gitLeakScanScript,
  parseSecretLedger,
  readGitLeakScan,
  secretLedgerEntriesFor,
  secretLedgerFile,
} from "../src/sandbox/secret-leak-guard";

const TOKEN = "vck_live_8f2KqT0xN4sLm9Zr";
const PEM_LINE = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
const VALUES = {
  Token: TOKEN,
  Pem: `-----BEGIN PRIVATE KEY-----\n${PEM_LINE}\n-----END PRIVATE KEY-----\n`,
  Short: "abc",
};

function resolved(reference: string, value: string): ResolvedSecretValue {
  return {
    key: reference,
    reference: { raw: reference } as never,
    source: "opengeni" as never,
    vaultId: "v",
    vaultName: "v",
    itemId: "i",
    itemName: "i",
    fieldId: null,
    fieldName: "password",
    version: 1,
    material: { type: "text", value },
  };
}

describe("ledger and matching", () => {
  const key = new SecretLedgerKey("server-secret");

  test("matches the exact value inside a line, never a part of it", () => {
    const entries = secretLedgerEntriesFor(key, [resolved("{{secret:Token}}", TOKEN)]);
    const index = new SecretLedgerIndex(key, entries);
    expect(index.match(`API_KEY="${TOKEN}" # docs`)).toEqual(["{{secret:Token}}"]);
    expect(index.match(TOKEN.slice(0, -1))).toEqual([]);
    expect(index.match("API_KEY={{secret:Token}}")).toEqual([]);
  });

  test("tracks long lines of a multi-line value, and no short values", () => {
    const entries = secretLedgerEntriesFor(key, [
      resolved("{{secret:Pem}}", VALUES.Pem),
      resolved("{{secret:Short}}", VALUES.Short),
    ]);
    const index = new SecretLedgerIndex(key, entries);
    expect(index.match(`  ${PEM_LINE}`)).toEqual(["{{secret:Pem}}"]);
    expect(index.match("-----BEGIN PRIVATE KEY-----")).toEqual([]);
    expect(index.match("abc abc")).toEqual([]);
  });

  test("the stored ledger holds no value and reads back only with its key", () => {
    const entries = secretLedgerEntriesFor(key, [resolved("{{secret:Token}}", TOKEN)]);
    const file = secretLedgerFile(key, entries);
    expect(file.path.startsWith("/tmp/opengeni-private/secret-ledger/")).toBe(true);
    const text = new TextDecoder().decode(file.content);
    expect(text).not.toContain(TOKEN);
    expect(parseSecretLedger(key, text)).toEqual(entries);
    expect(parseSecretLedger(new SecretLedgerKey("other-secret"), text)).toEqual([]);
  });

  test("diff output maps a match to its file, line and commit", () => {
    const entries = secretLedgerEntriesFor(key, [resolved("{{secret:Token}}", TOKEN)]);
    const commit = "a".repeat(40);
    const output = [
      "OPENGENI-LEAK-LEDGER",
      "OPENGENI-LEAK-CONTENT",
      "OPENGENI-LEAK-REPO /work/repo",
      "diff --git a/docs/README.md b/docs/README.md",
      "--- a/docs/README.md",
      "+++ b/docs/README.md",
      "@@ -3,0 +4,2 @@",
      "+++ heading that starts with two plus signs",
      `+key: ${TOKEN}`,
      `commit ${commit}`,
      "diff --git a/.env.example b/.env.example",
      "+++ b/.env.example",
      "@@ -1 +1 @@",
      `-OLD=${TOKEN}`,
      "+NEW=placeholder",
      "@@ -9,0 +10 @@",
      `+X=${TOKEN}`,
    ].join("\n");
    expect(readGitLeakScan(output, key, entries)).toEqual([
      {
        repository: "/work/repo",
        commit: null,
        path: "docs/README.md",
        line: 5,
        reference: "{{secret:Token}}",
      },
      {
        repository: "/work/repo",
        commit,
        path: ".env.example",
        line: 10,
        reference: "{{secret:Token}}",
      },
    ]);
  });

  test("reads which content a command hands to git", () => {
    expect(gitLeakPlan("ls -la && git status")).toBeNull();
    expect(gitLeakPlan("git log --grep=push")).toBeNull();
    expect(gitLeakPlan("git commit -m 'add -a flag'")).toEqual({
      directories: ["."],
      commit: true,
      stagesTracked: false,
      stagesUntracked: false,
      push: false,
    });
    expect(gitLeakPlan("git commit -am wip 2>&1 > log.txt")).toMatchObject({
      stagesTracked: true,
      stagesUntracked: false,
    });
    expect(gitLeakPlan('git commit -m "x" -- src/a.ts')).toMatchObject({ stagesTracked: true });
    expect(
      gitLeakPlan('cd repos/app && git add -A && git commit -m "docs" && git -C ../lib push'),
    ).toEqual({
      directories: [".", "repos/app", "../lib"],
      commit: true,
      stagesTracked: true,
      stagesUntracked: true,
      push: true,
    });
    expect(gitLeakPlan("git push origin HEAD")).toMatchObject({ commit: false, push: true });
  });

  test("the helper only reads untracked files when the command runs git add", () => {
    const commit = gitLeakScanScript(gitLeakPlan("git commit -m x")!, { ledgerKnown: true });
    expect(commit).toContain("diff --cached");
    expect(commit).not.toContain("ls-files");
    expect(commit).not.toContain("git -c core.quotePath=false log");
    const all = gitLeakScanScript(gitLeakPlan("git add . && git commit -m x && git push")!, {
      ledgerKnown: false,
    });
    expect(all).toContain("ls-files --others --exclude-standard");
    expect(all).toContain("HEAD --not --remotes");
  });
});
