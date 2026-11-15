/**
 * The secret leak guard on a real local sandbox (docs/secrets.md, "Keeping
 * values out of commits"): a git commit or push that would carry a value
 * Opengeni delivered into the sandbox is refused, naming the file and line;
 * files git would not take never block a commit. Uses only the public tool
 * wrapping, so it shows the behaviour a model sees.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Tool } from "@openai/agents";
import { Manifest, shell } from "@openai/agents/sandbox";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticSecretResolver } from "@opengeni/vaults/testing";
import { testSettings } from "@opengeni/testing/settings";
import { createSandboxClientForBackend } from "../src/index";
import {
  createTurnToolCancellationController,
  wrapCapabilityToolsForTurnCancellation,
} from "../src/sandbox/turn-tool-cancellation";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";
import { parseExecResponseBanner } from "../src/sandbox/exec-banner";

const TOKEN = "vck_live_8f2KqT0xN4sLm9Zr";
const PEM_LINE = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
const VALUES = {
  Token: TOKEN,
  Pem: `-----BEGIN PRIVATE KEY-----\n${PEM_LINE}\n-----END PRIVATE KEY-----\n`,
  Short: "abc",
};

type LocalSession = {
  close(): Promise<void>;
  execCommand(args: { cmd: string } & Record<string, unknown>): Promise<string>;
};

const sessions: LocalSession[] = [];
const root = mkdtempSync(join(tmpdir(), "opengeni-leak-guard-test-"));
// The local backend's sandbox is this host: remove the ledger files these
// tests add to its private directory.
const LEDGER = "/tmp/opengeni-private/secret-ledger";
const ledgerFiles = () => (existsSync(LEDGER) ? readdirSync(LEDGER) : []);
const ledgerBefore = new Set(ledgerFiles());
const addedLedgerFiles = () => ledgerFiles().filter((name) => !ledgerBefore.has(name));
afterAll(() => {
  for (const name of addedLedgerFiles()) rmSync(join(LEDGER, name), { force: true });
  rmSync(root, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async (session) => await session.close()));
});

async function sandbox() {
  const home = mkdtempSync(join(root, "home-"));
  const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
  const client = createSandboxClientForBackend("local", settings) as {
    create(manifest?: unknown): Promise<LocalSession>;
  };
  const local = await client.create(
    new Manifest({
      environment: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: root,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }),
  );
  sessions.push(local);
  const routing = new RoutingSandboxSession({
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => ({
      session: local as never,
      sandboxId: null,
      kind: "local",
      leaseEpoch: 1,
      providerInstanceId: "instance",
      activeEpoch: 0,
    }),
    beforeMutation: async () => ({}),
    afterMutation: async () => undefined,
  });
  await routing.prime();
  /** One attempt: a fresh controller (and in-memory ledger) on the same sandbox. */
  const attempt = () => {
    const resolver = createStaticSecretResolver(VALUES);
    // Every attempt in this process derives the same ledger key.
    const controller = createTurnToolCancellationController(undefined, {
      secretResolver: resolver,
    });
    const capability = shell();
    wrapCapabilityToolsForTurnCancellation(capability as never, controller);
    const tools = capability
      .clone()
      .bind(routing as never)
      .tools() as Tool<unknown>[];
    const fn = (name: string) =>
      tools.find(
        (tool): tool is Extract<Tool<unknown>, { type: "function" }> =>
          tool.type === "function" && tool.name === name,
      )!;
    const exec = fn("exec_command");
    const write = fn("write_stdin");
    return async (cmd: string): Promise<string> => {
      let current = (await exec.invoke(
        {} as never,
        JSON.stringify({ cmd, tty: false, yield_time_ms: 2_000 }),
        { toolCall: { callId: `call_${crypto.randomUUID()}` } } as never,
      )) as string;
      let output = current;
      for (let round = 0; round < 80; round += 1) {
        const banner = parseExecResponseBanner(current);
        if (banner.kind !== "running") break;
        current = (await write.invoke(
          {} as never,
          JSON.stringify({ session_id: banner.sessionId, chars: "", yield_time_ms: 250 }),
        )) as string;
        output += `\n${current}`;
      }
      return output;
    };
  };
  return { local, home, attempt };
}

describe("git commit and push on the local backend", () => {
  test("a commit carrying a delivered value is refused; a literal reference commits", async () => {
    const box = await sandbox();
    const run = box.attempt();
    await run("git init -q repo && cd repo && git commit -q --allow-empty -m init");
    // The incident: documenting a reference wrote its value into the file.
    await run("cd repo && printf 'Key: %s\\n' '{{secret:Token}}' > README.md");
    const refused = await run("cd repo && git add README.md && git commit -qm docs && echo DONE");
    expect(refused).toContain("Nothing was run");
    expect(refused).toContain("README.md line 1");
    expect(refused).toContain("the value of {{secret:Token}}");
    expect(refused).toContain("\\{{secret:…}}");
    expect(refused).not.toContain("DONE");
    expect(refused).not.toContain(TOKEN);
    expect(await run("cd repo && git rev-list --count HEAD")).toMatch(/\b1\b/u);
    expect(await run("cd repo && git diff --cached --name-only | wc -l")).toMatch(/\b0\b/u);
    // The check wrote nothing into the repository, not even the file's blob.
    expect(
      await run(
        "cd repo && git cat-file -e $(git hash-object README.md) && echo PRESENT || echo ABSENT",
      ),
    ).toContain("ABSENT");

    // Written with the escape, the reference stays text and commits.
    await run("cd repo && printf 'Key: %s\\n' '\\{{secret:Token}}' > README.md");
    expect(await run("cd repo && cat README.md")).toContain("Key: {{secret:Token}}");
    const committed = await run("cd repo && git add README.md && git commit -qm docs && echo DONE");
    expect(committed).toContain("DONE");
    // The ledger in the sandbox holds no value.
    const added = addedLedgerFiles();
    expect(added.length).toBeGreaterThan(0);
    for (const name of added) {
      expect(readFileSync(join(LEDGER, name), "utf8")).not.toContain(TOKEN);
    }
  }, 60_000);

  test("files git would not take never block a commit", async () => {
    const box = await sandbox();
    const run = box.attempt();
    await run(
      "git init -q repo && cd repo && printf '.env\\n' > .gitignore && git add .gitignore && git commit -qm init",
    );
    // An ignored .env and an untracked note both hold the value.
    await run("cd repo && printf 'TOKEN=%s\\n' '{{secret:Token}}' > .env && cp .env note.txt");
    await run("cd repo && printf 'v2\\n' >> .gitignore");
    // commit -a takes tracked changes only; the untracked note stays out.
    expect(await run("cd repo && git commit -qam tracked && echo DONE")).toContain("DONE");
    await run("cd repo && rm note.txt && printf 'x\\n' > other.txt");
    // git add -A takes untracked files that are not ignored; .env is ignored.
    expect(await run("cd repo && git add -A && git commit -qm all && echo DONE")).toContain("DONE");
  }, 60_000);

  test("only what the commit or push takes is checked", async () => {
    const box = await sandbox();
    const run = box.attempt();
    await run(
      "git init -q --bare remote.git && git init -q repo && git init -q other && cd repo && git remote add origin ../remote.git && git commit -q --allow-empty -m init && git push -q origin HEAD:refs/heads/main && git fetch -q origin && cd ../other && git commit -q --allow-empty -m init",
    );
    // An untracked note holds the value; other files are committed by name.
    await run("cd repo && printf 'TOKEN=%s\\n' '{{secret:Token}}' > notes.txt");
    await run("cd repo && printf 'a\\n' > a.txt && printf 'b\\n' > b.txt && git add b.txt");
    expect(await run("cd repo && git add a.txt && git commit -qm a && echo DONE")).toContain(
      "DONE",
    );
    expect(
      await run("cd repo && printf a2 >> a.txt && git add -u && git commit -qm u && echo DONE"),
    ).toContain("DONE");
    // A staged value that the push does not send never blocks the push.
    await run("cd repo && git add notes.txt");
    expect(await run("cd repo && git push -q origin HEAD:refs/heads/main && echo DONE")).toContain(
      "DONE",
    );
    // Committing in another repository is not about this repository's index.
    expect(
      await run("cd repo && cd ../other && git commit -q --allow-empty -m e && echo DONE"),
    ).toContain("DONE");
    // A commit run through a shell wrapper is checked.
    const refused = await run(`cd repo && bash -c 'git commit -qm notes' && echo DONE`);
    expect(refused).toContain("Nothing was run");
    expect(refused).toContain("notes.txt line 1");
    expect(refused).not.toContain("DONE");
  }, 60_000);

  test("a later attempt refuses to push a commit holding a value from an earlier one", async () => {
    const box = await sandbox();
    const first = box.attempt();
    await first(
      "git init -q --bare remote.git && git init -q repo && cd repo && git remote add origin ../remote.git && git commit -q --allow-empty -m init && git push -q origin HEAD:refs/heads/main && git fetch -q origin",
    );
    await first("cd repo && printf 'Key: %s\\n' '{{secret:Token}}' > config.yml");
    // Committed outside Opengeni's shell (for example by a script): only the
    // push is left to stop it, in a new attempt with an empty memory.
    await box.local.execCommand({
      cmd: `cd repo && git add config.yml && git commit -qm config`,
    });
    const second = box.attempt();
    const refused = await second("cd repo && git push -q origin HEAD:refs/heads/main && echo DONE");
    expect(refused).toContain("Nothing was run");
    expect(refused).toMatch(/config\.yml line 1 in commit [0-9a-f]{12}/u);
    expect(refused).not.toContain("DONE");
    expect(await second("git --git-dir=remote.git rev-list --count main")).toMatch(/\b1\b/u);
  }, 60_000);
});
