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

  test("plain-text fields are not tracked, and keys are scoped per workspace", () => {
    const username = { ...resolved("user", TOKEN), fieldKind: "text" as const };
    expect(secretLedgerEntriesFor(key, [username])).toEqual([]);
    const concealed = { ...resolved("pw", TOKEN), fieldKind: "concealed" as const };
    expect(secretLedgerEntriesFor(key, [concealed])).toHaveLength(1);
    const one = key.scoped("workspace-1");
    const text = new TextDecoder().decode(
      secretLedgerFile(one, secretLedgerEntriesFor(one, [concealed])).content,
    );
    expect(parseSecretLedger(one, text)).toHaveLength(1);
    expect(parseSecretLedger(key.scoped("workspace-2"), text)).toEqual([]);
    expect(parseSecretLedger(key, text)).toEqual([]);
    // The stored hash is only a 16-bit hint.
    expect(parseSecretLedger(one, text)[0]!.hash).toBeLessThan(65_536);
  });
});

describe("reading git steps from a command", () => {
  test("commands without a commit or push need no helper", () => {
    expect(gitLeakPlan("ls -la && git status")).toBeNull();
    expect(gitLeakPlan("git log --grep=push")).toBeNull();
    expect(gitLeakPlan("echo git commit && echo git push")).toBeNull();
    expect(gitLeakPlan("git add -A")).toBeNull();
    expect(gitLeakPlan("git commit --dry-run -a")).toBeNull();
    expect(gitLeakPlan("git push --delete origin old")).toBeNull();
  });

  test("commit staging modes", () => {
    expect(gitLeakPlan("git commit -m 'add -a flag'")?.steps).toEqual([
      { kind: "commit", directory: ".", stage: "index", paths: [] },
    ]);
    expect(gitLeakPlan("git commit -am wip 2>&1 > log.txt")?.steps).toEqual([
      { kind: "commit", directory: ".", stage: "all", paths: [] },
    ]);
    expect(gitLeakPlan("git commit -uno -m x")?.steps).toEqual([
      { kind: "commit", directory: ".", stage: "index", paths: [] },
    ]);
    expect(gitLeakPlan('git commit -m "x" -- src/a.ts')?.steps).toEqual([
      { kind: "commit", directory: ".", stage: "only", paths: ["src/a.ts"] },
    ]);
    expect(gitLeakPlan("git commit -i -m x b.ts")?.steps).toEqual([
      { kind: "commit", directory: ".", stage: "include", paths: ["b.ts"] },
    ]);
  });

  test("directories, adds, pushes and shell wrappers", () => {
    expect(
      gitLeakPlan(
        'cd repos/app && git add docs/a.md && git commit -m "docs" && git -C ../lib push origin feature:main',
      )?.steps,
    ).toEqual([
      { kind: "add", directory: "repos/app", args: ["docs/a.md"] },
      { kind: "commit", directory: "repos/app", stage: "index", paths: [] },
      { kind: "push", directory: "repos/app/../lib", revisions: ["feature"] },
    ]);
    expect(gitLeakPlan("git push")?.steps).toEqual([
      { kind: "push", directory: ".", revisions: ["HEAD"] },
    ]);
    expect(gitLeakPlan("git push --all origin")?.steps).toEqual([
      { kind: "push", directory: ".", revisions: ["--branches"] },
    ]);
    expect(gitLeakPlan(`bash -lc 'cd app && git commit -qm x'`)?.steps).toEqual([
      { kind: "commit", directory: "app", stage: "index", paths: [] },
    ]);
    expect(gitLeakPlan("GIT_AUTHOR_NAME=x env -i GIT_DIR_X=1 git commit -m y")?.steps).toHaveLength(
      1,
    );
    // Interactive adds and unknown directories are not replayed or checked.
    expect(gitLeakPlan("git add -p && git commit -m x")?.steps).toEqual([
      { kind: "commit", directory: ".", stage: "index", paths: [] },
    ]);
    expect(gitLeakPlan('cd "$REPO" && git commit -m x')).toBeNull();
    expect(gitLeakPlan("git --git-dir=/x/.git commit -m x")).toBeNull();
  });

  test("the helper replays adds on a throwaway index and has a deadline", () => {
    const script = gitLeakScanScript(gitLeakPlan("git add . && git commit -m x && git push")!, {
      ledgerKnown: false,
    });
    expect(script).toContain("exec timeout -k 2 15 sh -c");
    expect(script).toContain(`GIT_INDEX_FILE="$ix" git add '.'`);
    expect(script).toContain("diff --cached");
    expect(script).toContain("'HEAD' --not --remotes");
    expect(script).not.toContain("ls-files");
  });
});
