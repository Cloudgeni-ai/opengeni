/**
 * The secrets gate scenarios (dossier §12 "E2E", §13.6, §17.1): E2E-1..E2E-12
 * plus baseline smokes that prove the harness itself works on today's stack.
 *
 * A scenario declares the product features it needs (features.ts). When any is
 * missing the scenario fails with status `missing_feature` and the exact probe
 * detail, so a run on an unfinished branch is red for a stated reason. When the
 * features exist, the scenario body drives the real path: real Gateway turns
 * (`mode: "real"`) or the model-free directive worker (`mode: "scripted"`), the
 * fake-login suite as the oracle (successful logins plus the exact values its
 * server received), and a known-value scan of every turn's events.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type FakeLoginServer,
  startFakeLoginServer,
} from "../../../packages/testing/src/fake-login";
import { totp } from "../../../packages/testing/src/fake-login/totp";
import {
  type FeatureId,
  type FeatureProbe,
  type FeatureReport,
  KEYS_DIR,
  missingFeatures,
} from "./features";
import { type Needle, type KnownValue, needlesFor, scanBuffer, scrubKnownValues } from "./scan";
import { authStatePath, type StackApi, type StackState } from "./stack";
import {
  type DirectiveReport,
  type TurnResult,
  directiveMessage,
  eventTrail,
  execStep,
  parseDirectiveReport,
  runTurn,
} from "./turns";
import { VaultClient } from "./vault-client";

export type ScenarioMode = "real" | "scripted" | "sweep" | "upgrade";

export type ScenarioStatus = "passed" | "failed" | "missing_feature" | "incomplete" | "error";

export type Check = { name: string; ok: boolean; detail?: string };

export type ScenarioResult = {
  id: string;
  title: string;
  mode: ScenarioMode;
  acceptance: string[];
  status: ScenarioStatus;
  reason?: string;
  missing?: FeatureProbe[];
  checks: Check[];
  sessions: string[];
  durationMs: number;
};

export type ScenarioContext = {
  stack: StackState;
  owner: StackApi;
  member: StackApi;
  viewer: StackApi;
  workspaceId: string;
  features: FeatureReport;
  fakeLogin: FakeLoginServer;
  /** Real-model id for `mode: "real"` turns (built-in Azure deployment such as gpt-6-sol, or a Gateway product id). */
  model: string;
  /** Known secret values for this run (canaries plus per-scenario values). */
  knownValues: KnownValue[];
  evidenceDir: string;
  machineSandboxId?: string;
  log: (line: string) => void;
  /** Run the canary sweep (E2E-11, SWEEP-SELFTEST). */
  sweep: (
    values: KnownValue[],
    options: { expectHits: boolean; out: string },
  ) => Promise<{
    ok: boolean;
    summary: string;
  }>;
};

export type Scenario = {
  id: string;
  title: string;
  mode: ScenarioMode;
  acceptance: string[];
  requires: FeatureId[];
  run: (context: ScenarioContext, scenario: ScenarioRun) => Promise<void>;
};

/** Mutable per-scenario recorder handed to the scenario body. */
export class ScenarioRun {
  readonly checks: Check[] = [];
  readonly sessions: string[] = [];
  incomplete: string | undefined;

  constructor(
    readonly id: string,
    readonly dir: string,
    readonly needles: () => Needle[],
  ) {}

  check(name: string, ok: boolean, detail?: string): boolean {
    this.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    return ok;
  }

  /** Mark the remainder of the scenario as not yet implemented in the harness. */
  notImplemented(what: string): void {
    this.incomplete = what;
  }

  /** Record a turn: value-free trail, scrubbed tool calls, and a leak check. */
  recordTurn(label: string, turn: TurnResult): void {
    this.sessions.push(turn.sessionId);
    const needles = this.needles();
    const leaks = scanBuffer(`turn:${label}`, JSON.stringify(turn.events), needles);
    this.check(
      `${label}: no known secret value in session events`,
      leaks.length === 0,
      leaks.map((hit) => `${hit.label}/${hit.encoding} x${hit.count}`).join(", ") || undefined,
    );
    const calls = scrubKnownValues(
      JSON.stringify(
        turn.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })),
        null,
        2,
      ),
      needles,
    );
    writeFileSync(
      join(this.dir, `${label}.turn.json`),
      `${JSON.stringify(
        {
          sessionId: turn.sessionId,
          url: turn.url,
          status: turn.status,
          failure: turn.failure ?? null,
          durationMs: turn.durationMs,
          trail: eventTrail(turn),
          assistantText: scrubKnownValues(turn.assistantText, needles).text,
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(this.dir, `${label}.tool-calls.json`), `${calls.text}\n`);
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function requireTurnCompleted(run: ScenarioRun, label: string, turn: TurnResult): boolean {
  return run.check(
    `${label}: turn completed`,
    turn.status === "completed",
    turn.status === "completed"
      ? undefined
      : `${turn.status}${turn.failure ? ` ${turn.failure.code ?? ""} ${turn.failure.message ?? ""}` : ""}`,
  );
}

function loginSucceeded(context: ScenarioContext, flow: string, username: string): boolean {
  return context.fakeLogin
    .state()
    .successes.some((success) => success.flow === flow && success.username === username);
}

function receivedExactly(
  context: ScenarioContext,
  flow: string,
  field: string,
  value: string,
): boolean {
  return context.fakeLogin
    .received()
    .some((row) => row.flow === flow && row.field === field && row.value === value);
}

async function scriptedTurn(
  context: ScenarioContext,
  run: ScenarioRun,
  label: string,
  steps: Parameters<typeof directiveMessage>[0],
  extra: { machineSandboxId?: string; extraBody?: Record<string, unknown> } = {},
): Promise<{ turn: TurnResult; report: DirectiveReport | null }> {
  const turn = await runTurn(context.owner, {
    workspaceId: context.workspaceId,
    message: directiveMessage(steps, `${run.id} ${label}`),
    ...(extra.machineSandboxId ? { machineSandboxId: extra.machineSandboxId } : {}),
    ...(extra.extraBody ? { extraBody: extra.extraBody } : {}),
    timeoutMs: 180_000,
  });
  run.recordTurn(label, turn);
  requireTurnCompleted(run, label, turn);
  const report = parseDirectiveReport(turn.assistantText);
  run.check(`${label}: directive report parsed`, report !== null && !report.error, report?.error);
  return { turn, report };
}

async function realTurn(
  context: ScenarioContext,
  run: ScenarioRun,
  label: string,
  message: string,
  options: { sessionId?: string; machineSandboxId?: string; timeoutMs?: number } = {},
): Promise<TurnResult> {
  const turn = await runTurn(context.owner, {
    workspaceId: context.workspaceId,
    message,
    model: context.model,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.machineSandboxId ? { machineSandboxId: options.machineSandboxId } : {}),
    timeoutMs: options.timeoutMs ?? 600_000,
  });
  run.recordTurn(label, turn);
  requireTurnCompleted(run, label, turn);
  return turn;
}

/**
 * A real-model browser turn. The managed browser runs on the connected machine
 * here (the local sandbox backend has no browser), so browser scenarios target
 * it and must actually drive the browser rather than fall back to curl.
 */
async function browserTurn(
  context: ScenarioContext,
  run: ScenarioRun,
  label: string,
  message: string,
): Promise<TurnResult> {
  const turn = await realTurn(
    context,
    run,
    label,
    `${message} Use the browser tools for the website, not curl or scripts.`,
    context.machineSandboxId ? { machineSandboxId: context.machineSandboxId } : {},
  );
  run.check(
    `${label}: drove the managed browser`,
    turn.toolCalls.some((call) => /browser_(act|open|navigate)/u.test(call.name)),
    [...new Set(turn.toolCalls.map((call) => call.name))].join(","),
  );
  return turn;
}

async function defaultVaultId(context: ScenarioContext, run: ScenarioRun): Promise<string | null> {
  const vaults = new VaultClient(context.owner, context.workspaceId);
  const listed = await vaults.listVaults();
  const rows: any[] = listed.json?.vaults ?? [];
  const vault =
    rows.find((row) => row.ownerKind === "user" && row.isDefault) ??
    rows.find((row) => row.ownerKind === "user") ??
    rows[0];
  run.check(
    "owner has a writable default vault",
    Boolean(vault),
    `GET /vaults -> ${listed.status}`,
  );
  return vault?.id ?? null;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "BASE-SCRIPTED",
    title: "Baseline: scripted directive turn runs exec_command on the local sandbox",
    mode: "scripted",
    acceptance: ["harness"],
    requires: ["directive_worker"],
    run: async (context, run) => {
      const marker = `f598-scripted-${crypto.randomUUID().slice(0, 8)}`;
      // Hash the reference so the step never prints a secret on the vaults
      // build (there is no output redaction by design, brief C1).
      const { report } = await scriptedTurn(context, run, "exec", [
        execStep(`echo ${marker}`),
        execStep(`printf %s '{{secret:Canary}}' | sha256sum`),
      ]);
      run.check("exec output reached the model", report?.outputs[0]?.includes(marker) === true);
      const canary = context.knownValues.find((value) => value.label === "Canary");
      const expected = sha256(
        context.features.vaults_api?.present && canary ? canary.value : "{{secret:Canary}}",
      );
      run.check(
        context.features.vaults_api?.present
          ? "reference resolves to the vault value on this build"
          : "reference text is passed through literally on this build",
        report?.outputs[1]?.includes(expected) === true,
      );
      run.check("exec_command offered", report?.tools.includes("exec_command") === true);
    },
  },
  {
    id: "BASE-REAL",
    title: "Baseline: a real model completes a tool-using turn",
    mode: "real",
    acceptance: ["harness", "AG-6 prerequisite"],
    requires: ["real_model"],
    run: async (context, run) => {
      const turn = await realTurn(
        context,
        run,
        "uname",
        "Run the shell command `uname -s && echo f598-real-ok` with your command tool and reply with its exact output.",
        { timeoutMs: 300_000 },
      );
      const execCall = turn.toolCalls.find((call) => /exec|shell|command/u.test(call.name));
      run.check("model called a command tool", Boolean(execCall), execCall?.name);
      run.check(
        "final answer carries the command output",
        turn.assistantText.includes("f598-real-ok"),
      );
    },
  },
  {
    id: "BASE-MACHINE",
    title: "Baseline: scripted exec on the connected machine (real Rust agent)",
    mode: "scripted",
    acceptance: ["harness", "E2E-6 prerequisite"],
    requires: ["directive_worker", "connected_machine"],
    run: async (context, run) => {
      const marker = `f598-machine-${crypto.randomUUID().slice(0, 8)}`;
      const { report } = await scriptedTurn(
        context,
        run,
        "machine-exec",
        [execStep(`echo ${marker} && uname -s`)],
        { machineSandboxId: context.machineSandboxId! },
      );
      run.check(
        "machine exec output reached the model",
        report?.outputs[0]?.includes(marker) === true,
      );
    },
  },
  {
    id: "SWEEP-SELFTEST",
    title: "Canary sweep detects a value planted in a session (detection self-test)",
    mode: "scripted",
    acceptance: ["SEC-1 harness", "OB-3 harness"],
    requires: ["directive_worker"],
    run: async (context, run) => {
      const planted = `OGPLANT-${crypto.randomUUID()}`;
      const turn = await runTurn(context.owner, {
        workspaceId: context.workspaceId,
        message: directiveMessage([execStep(`echo ${planted}`)], `${run.id} plant ${planted}`),
        timeoutMs: 180_000,
      });
      run.sessions.push(turn.sessionId);
      requireTurnCompleted(run, "plant", turn);
      const result = await context.sweep([{ label: "planted", value: planted }], {
        expectHits: true,
        out: join(run.dir, "sweep-selftest.json"),
      });
      run.check("sweep found the planted value", result.ok, result.summary);
    },
  },
  {
    id: "E2E-1",
    title: "Real-model turn logs into the fake password site with a saved login",
    mode: "real",
    acceptance: ["E2E-1", "BR-1", "RF-*", "AG-1"],
    requires: ["vaults_api", "secret_tools", "real_model"],
    run: async (context, run) => {
      const account = context.fakeLogin.account("alice")!;
      const vaultId = await defaultVaultId(context, run);
      if (!vaultId) return;
      const vaults = new VaultClient(context.owner, context.workspaceId);
      const created = await vaults.replaceItem(vaultId, {
        type: "login",
        name: "Fake Login Alice",
        websites: [context.fakeLogin.url],
        fields: [
          { name: "username", kind: "text", value: account.username },
          { name: "password", kind: "concealed", value: account.password },
        ],
      });
      if (!run.check("seed login item", created.ok, `${created.status}`)) return;
      await browserTurn(
        context,
        run,
        "login",
        `Open ${context.fakeLogin.url}/password in the browser and sign in with the login saved in my vault for this site. Do not ask me for the password. Tell me who the page says is logged in.`,
      );
      run.check(
        "fake site: alice logged in via password",
        loginSucceeded(context, "password", "alice"),
      );
      run.check(
        "fake site received the exact saved password",
        receivedExactly(context, "password", "password", account.password),
      );
    },
  },
  {
    id: "E2E-2",
    title: "TOTP enrollment, then a TOTP login in a new session",
    mode: "real",
    acceptance: ["E2E-2", "GEN-*", "BR-*"],
    requires: ["vaults_api", "secret_tools", "real_model"],
    run: async (context, run) => {
      const account = context.fakeLogin.account("alice")!;
      await browserTurn(
        context,
        run,
        "enroll",
        `Sign in at ${context.fakeLogin.url}/password with my saved login, then enable two-factor at ${context.fakeLogin.url}/totp/enroll. Save the TOTP seed to that login in my vault before confirming the code.`,
      );
      const enrolled = context.fakeLogin.state().accounts.find((row) => row.username === "alice");
      if (!run.check("fake site: TOTP enabled for alice", enrolled?.totpEnabled === true)) return;
      await browserTurn(
        context,
        run,
        "totp-login",
        `In a fresh browser, sign in at ${context.fakeLogin.url}/totp/login with my saved login including its one-time code.`,
      );
      run.check("fake site: alice logged in via totp", loginSucceeded(context, "totp", "alice"));
      run.check(
        "fake site received the exact password on the TOTP login",
        receivedExactly(context, "totp", "password", account.password),
      );
    },
  },
  {
    id: "E2E-3",
    title: "Signup with a generated password (saved first), then a re-login",
    mode: "real",
    acceptance: ["E2E-3", "GEN-1", "AG-2"],
    requires: ["vaults_api", "secret_tools", "real_model"],
    run: async (context, run) => {
      const username = `gate-${crypto.randomUUID().slice(0, 8)}`;
      const signup = await browserTurn(
        context,
        run,
        "signup",
        `Create an account at ${context.fakeLogin.url}/signup with the username ${username}. Generate a strong password and save the login to my vault before you submit the form.`,
      );
      const saveCall = signup.toolCalls.find((call) => call.name === "secret_save");
      run.check("agent saved the login with secret_save", Boolean(saveCall));
      run.check(
        "secret_save used the generator, not a literal value",
        JSON.stringify(saveCall?.arguments ?? {}).includes('"generate"'),
      );
      run.check("fake site: signup succeeded", loginSucceeded(context, "signup", username));
      await browserTurn(
        context,
        run,
        "relogin",
        `Sign in at ${context.fakeLogin.url}/password as ${username} using the saved login.`,
      );
      run.check("fake site: re-login succeeded", loginSucceeded(context, "password", username));
    },
  },
  {
    id: "E2E-4",
    title: "Missing credential raises the ask card; Playwright fills it as the human",
    mode: "real",
    acceptance: ["E2E-4", "AC-3", "AC-4", "UI S9"],
    requires: ["vaults_api", "secret_tools", "ask_card_secret_field", "real_model"],
    run: async (context, run) => {
      const username = `ask-${crypto.randomUUID().slice(0, 8)}`;
      const ask = await runTurn(context.owner, {
        workspaceId: context.workspaceId,
        model: context.model,
        message: `Create an account at ${context.fakeLogin.url}/signup with the username ${username}. I want to choose the password myself: ask me for it with a secret question that offers to generate one, save it as a login in my vault, then sign up with it using the browser tools (not curl).`,
        stopOnEventTypes: ["session.humanInput.requested"],
        ...(context.machineSandboxId ? { machineSandboxId: context.machineSandboxId } : {}),
        timeoutMs: 600_000,
      });
      run.recordTurn("ask", ask);
      if (!run.check("agent raised an ask card", ask.status === "paused", ask.status)) return;
      const requested = ask.events.find((event) => event.type === "session.humanInput.requested");
      run.check(
        "the card has a secret question",
        JSON.stringify(requested?.data ?? {}).includes('"secret"'),
      );

      // Answer as the person, in the real web UI: Generate, then send.
      const { chromium } = await import("playwright");
      const browser = await chromium.launch();
      try {
        for (const [label, viewport] of [
          ["desktop", { width: 1440, height: 900 }],
          ["mobile", { width: 390, height: 844 }],
        ] as const) {
          const page = await browser.newPage({
            viewport,
            storageState: authStatePath(context.stack, "owner"),
          });
          await page.goto(ask.url);
          const field = page.locator("[data-secret-question]").first();
          await field.waitFor({ timeout: 60_000 });
          await field.scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(run.dir, `ask-card-${label}.png`) });
          if (label === "mobile") {
            await page.close();
            continue;
          }
          await field.getByRole("button", { name: "Generate" }).click();
          await page.screenshot({ path: join(run.dir, `ask-card-generated-${label}.png`) });
          const typed = await field.locator('input[name^="secret-"]').inputValue();
          run.check(
            "Generate filled a strong password",
            typed.length >= 16,
            `${typed.length} chars`,
          );
          await page
            .getByRole("button", { name: /^(Send|Submit)/u })
            .first()
            .click();
          await page
            .locator("[data-secret-question]")
            .first()
            .waitFor({ state: "detached", timeout: 60_000 });
          await page.screenshot({ path: join(run.dir, `ask-card-answered-${label}.png`) });
          await page.close();
        }
      } finally {
        await browser.close();
      }

      // Follow the session until the turn that consumes the answer finishes.
      let after = ask.lastSequence;
      let sawAnswer = false;
      let done: TurnResult | null = null;
      for (let round = 0; round < 4 && !done; round += 1) {
        const next = await runTurn(context.owner, {
          workspaceId: context.workspaceId,
          sessionId: ask.sessionId,
          message: "",
          resumeAfterSequence: after,
          timeoutMs: 600_000,
        });
        after = next.lastSequence;
        sawAnswer ||= next.events.some((event) => event.type === "user.humanInputResponse");
        run.recordTurn(`after-answer-${round}`, next);
        if (sawAnswer && next.status !== "timeout") done = next;
        if (next.status === "timeout") break;
      }
      run.check("the answer reached the agent", sawAnswer);
      if (!done) return;
      requireTurnCompleted(run, "after-answer", done);

      // The vault holds the generated password and the site received exactly it.
      const vaults = new VaultClient(context.owner, context.workspaceId);
      const saved = await vaults.findItemByName(username);
      if (!run.check("the login is in the owner's vault", Boolean(saved), username)) return;
      const password = await vaults.revealFieldByName(saved!.vaultId, saved!.id, "password");
      if (!run.check("the saved password can be revealed", Boolean(password))) return;
      context.knownValues.push({ label: "AskCardPassword", value: password! });
      run.check("fake site: signup succeeded", loginSucceeded(context, "signup", username));
      run.check(
        "fake site received exactly the generated password",
        receivedExactly(context, "signup", "password", password!),
      );
      const transcript = JSON.stringify(ask.events) + JSON.stringify(done.events);
      run.check("the password never appears in the session", !transcript.includes(password!));
    },
  },
  {
    id: "E2E-5",
    title: "Passkey registration, then a passkey login in a fresh browser session",
    mode: "real",
    acceptance: ["E2E-5", "BR-* passkeys"],
    requires: ["vaults_api", "secret_tools", "real_model"],
    run: async (context, run) => {
      await browserTurn(
        context,
        run,
        "register",
        `Sign in at ${context.fakeLogin.url}/password with my saved login, then register a passkey at ${context.fakeLogin.url}/passkey/register and keep it in my vault.`,
      );
      const passkeys =
        context.fakeLogin.state().accounts.find((row) => row.username === "alice")?.passkeys ?? [];
      if (!run.check("fake site: a passkey is registered for alice", passkeys.length > 0)) return;
      await browserTurn(
        context,
        run,
        "passkey-login",
        `In a new browser session, sign in at ${context.fakeLogin.url}/passkey/login with my saved passkey.`,
      );
      run.check("fake site: passkey login succeeded", loginSucceeded(context, "passkey", "alice"));
    },
  },
  {
    id: "E2E-6",
    title: "Connected machine (real Rust agent) runs a command with a reference",
    mode: "scripted",
    acceptance: ["E2E-6", "CM-1", "CM-3", "DL-9"],
    requires: ["vaults_api", "directive_worker", "connected_machine"],
    run: async (context, run) => {
      const canary = context.knownValues.find((value) => value.label === "Canary");
      if (!run.check("canary seeded", Boolean(canary))) return;
      const expected = sha256(canary!.value);
      const { turn, report } = await scriptedTurn(
        context,
        run,
        "machine-exec",
        [
          execStep(`printf %s "{{secret:Canary}}" | sha256sum`),
          execStep(`printf %s "{{secret:Canary}}" | sha256sum`, { shell: "bash" }),
          execStep("env | cut -d= -f1 | sort"),
        ],
        { machineSandboxId: context.machineSandboxId! },
      );
      run.check(
        "posix: hash of the resolved value matches",
        report?.outputs[0]?.includes(expected) === true,
      );
      run.check(
        "bash: hash of the resolved value matches",
        report?.outputs[1]?.includes(expected) === true,
      );
      const envDump = report?.outputs[2] ?? "";
      // The machine shares this host's /tmp with local-backend sessions, so look
      // only at this session's directory: lock files are fine, credentials are not.
      const sessionDir = `/tmp/opengeni-run-credentials/${turn.sessionId}`;
      const credentialFiles = existsSync(sessionDir)
        ? readdirSync(sessionDir, { recursive: true, withFileTypes: true }).filter(
            (entry) => entry.isFile() && entry.name !== ".pointer.lock",
          )
        : [];
      run.check(
        "CM-3: no run-credential files for the machine session",
        credentialFiles.length === 0,
        credentialFiles.map((entry) => entry.name).join(", ") || undefined,
      );
      run.check(
        "CM-3: no GH_TOKEN or GIT_* credential env",
        !/^(GH_TOKEN|GIT_ASKPASS|GIT_CONFIG)/mu.test(envDump),
      );
    },
  },
  {
    id: "E2E-7",
    title: "Live 1Password: read RO Test Login and log in; write to RW, then archive",
    mode: "real",
    acceptance: ["E2E-7", "OP-*"],
    requires: ["vaults_api", "secret_tools", "onepassword_token", "real_model"],
    run: async (context, run) => {
      const tokenLine = readFileSync(join(KEYS_DIR, "op.env"), "utf8")
        .split("\n")
        .find((line) => /ONEPASSWORD_TEST_SERVICE_ACCOUNT_TOKEN=/u.test(line));
      const token = tokenLine
        ?.split("=")
        .slice(1)
        .join("=")
        .replace(/^['"]|['"]$/gu, "")
        .trim();
      if (!run.check("service-account token available", Boolean(token))) return;
      const ws = `/v1/workspaces/${context.workspaceId}`;
      const install = await context.owner.request("POST", `${ws}/connections/1password/install`, {
        token,
        ownership: "workspace",
        planTier: "family",
        label: "Gate 1Password",
      });
      if (!run.check("install the 1Password connection", install.ok, `${install.status}`)) return;
      const connectionId = String(install.json.connectionId);
      const providerVaults: any[] = install.json.vaults ?? [];
      const ro = providerVaults.find((vault) => vault.name === "OpenGeni Test RO");
      const rw = providerVaults.find((vault) => vault.name === "OpenGeni Test RW");
      if (!run.check("both test vaults are listed", Boolean(ro && rw))) return;
      const link = async (vault: any, mode: "read_only" | "read_write") => {
        if (vault.linkedVaultId) return String(vault.linkedVaultId);
        const linked = await context.owner.request("POST", `${ws}/vaults/link`, {
          provider: "onepassword",
          connectionId,
          externalVaultId: vault.externalVaultId,
          ownerKind: "workspace",
          mode,
          name: vault.name,
        });
        run.check(
          `link ${vault.name} (${mode})`,
          linked.ok,
          `${linked.status} ${linked.text.slice(0, 200)}`,
        );
        return linked.ok ? String(linked.json.id ?? linked.json.vault?.id) : null;
      };
      const roVaultId = await link(ro, "read_only");
      const rwVaultId = await link(rw, "read_write");
      if (!roVaultId || !rwVaultId) return;

      // The read-only "Test Login" seeds a second fake site with the same account.
      const vaults = new VaultClient(context.owner, context.workspaceId);
      const items: any[] = (await vaults.listItems(roVaultId)).json?.items ?? [];
      const testLogin = items.find((item) => item.name === "Test Login");
      if (!run.check("RO mirror lists Test Login", Boolean(testLogin))) return;
      const username = await vaults.revealFieldByName(roVaultId, testLogin.id, "username");
      const password = await vaults.revealFieldByName(roVaultId, testLogin.id, "password");
      const item = (
        await context.owner.request("GET", `${ws}/vaults/${roVaultId}/items/${testLogin.id}`)
      ).json;
      const totpField = (item?.fields ?? []).find((field: any) => field.kind === "totp");
      const seed = totpField
        ? String(
            (await vaults.revealField(roVaultId, testLogin.id, totpField.id)).json?.value ?? "",
          )
        : "";
      if (
        !run.check(
          "live values read from 1Password (username, password, TOTP seed)",
          Boolean(username && password && seed),
        )
      ) {
        return;
      }
      context.knownValues.push({ label: "OnePasswordPassword", value: password! });
      const site = await startFakeLoginServer({
        port: 0,
        iframePort: 0,
        accounts: [{ username: username!, password: password!, totpSecret: seed }],
        log: () => undefined,
      });
      try {
        await browserTurn(
          context,
          run,
          "onepassword-login",
          `Sign in at ${site.url}/totp/login with the "Test Login" item from my "OpenGeni Test RO" vault, including its one-time code. Tell me what the page says after you sign in.`,
        );
        run.check(
          "fake site: TOTP login with the 1Password item succeeded",
          site.state().successes.some((row) => row.flow === "totp" && row.username === username),
        );
        run.check(
          "fake site received exactly the 1Password password",
          site
            .received()
            .some(
              (row) => row.flow === "totp" && row.field === "password" && row.value === password,
            ),
        );
      } finally {
        await site.close();
      }

      // Two-way: the agent writes a new login into the read-write vault.
      const name = `ogtest-gate-${crypto.randomUUID().slice(0, 8)}`;
      const save = await realTurn(
        context,
        run,
        "onepassword-save",
        `Save a new login named ${name} with username gate@example.test and a generated 24-character password in my "OpenGeni Test RW" vault. Do not show me the password.`,
      );
      run.check(
        "agent saved with secret_save",
        save.toolCalls.some((call) => call.name === "secret_save"),
      );
      const savedItems: any[] = (await vaults.listItems(rwVaultId)).json?.items ?? [];
      const saved = savedItems.find((row) => row.name === name);
      run.check("the new login is mirrored from 1Password", Boolean(saved));
      if (saved) {
        const generated = await vaults.revealFieldByName(rwVaultId, saved.id, "password");
        run.check("the generated password reads back live", (generated ?? "").length >= 24);
        if (generated)
          context.knownValues.push({ label: "OnePasswordGenerated", value: generated });
        const archived = await vaults.archiveItem(rwVaultId, saved.id);
        run.check("archive the item in 1Password", archived.ok, `${archived.status}`);
        const after: any[] = (await vaults.listItems(rwVaultId)).json?.items ?? [];
        run.check("the archived item left the mirror", !after.some((row) => row.name === name));
      }
    },
  },
  {
    id: "E2E-8",
    title: "Codemode script and a Site tool call resolve with the right authority",
    mode: "scripted",
    acceptance: ["E2E-8", "GW-4"],
    requires: ["vaults_api", "directive_worker"],
    run: async (_context, run) => {
      run.notImplemented(
        "publish a Site calling fake_mcp.echo with a reference and open it as viewer A (reach) and viewer B (no reach); run a Codemode script with a reference (W2 surfaces)",
      );
    },
  },
  {
    id: "E2E-9",
    title: "Schedule run uses the owner's Only-me secret; denied after the owner is removed",
    mode: "real",
    acceptance: ["E2E-9", "AX-3"],
    requires: ["vaults_api", "secret_tools", "real_model"],
    run: async (_context, run) => {
      run.notImplemented(
        "create a schedule with vaultPolicy (F2), trigger it, remove the owner's membership, trigger again and expect `denied`",
      );
    },
  },
  {
    id: "E2E-10",
    title: "Capability-off session: references stay literal and no secret tools exist",
    mode: "scripted",
    acceptance: ["E2E-10", "AG-4"],
    requires: ["vaults_api", "directive_worker", "secrets_capability_toggle"],
    run: async (context, run) => {
      const { report } = await scriptedTurn(
        context,
        run,
        "capability-off",
        [
          execStep(`printf %s "{{secret:Canary}}"`),
          { tool: "tool_list", args: { namePrefix: "secret_", limit: 40 } },
        ],
        { extraBody: { agent: { capabilities: { from: "all", secrets: false } } } },
      );
      run.check(
        "reference stays literal",
        report?.outputs[0]?.includes("{{secret:Canary}}") === true,
      );
      const offered = (report?.tools ?? []).filter((name) => name.startsWith("secret_"));
      const listed = /secret_(search|save|get|move|delete)/u.test(report?.outputs[1] ?? "");
      run.check(
        "no secret_* tools offered or listed",
        offered.length === 0 && !listed,
        offered.join(","),
      );
    },
  },
  {
    id: "E2E-11",
    title: "Canary sweep after E2E-1..E2E-10 (SEC-1..SEC-3, OB-3)",
    mode: "sweep",
    acceptance: ["E2E-11", "SEC-1", "SEC-2", "SEC-3", "SEC-5", "OB-3"],
    requires: ["vaults_api"],
    run: async (context, run) => {
      const canaries = context.knownValues.filter((value) => value.label !== "planted");
      if (!run.check("canaries seeded", canaries.length > 0)) return;
      const result = await context.sweep(canaries, {
        expectHits: false,
        out: join(run.dir, "sweep.json"),
      });
      run.check("sweep clean", result.ok, result.summary);
    },
  },
  {
    id: "E2E-12",
    title: "Upgrade path (DP-1): pre-vaults snapshot migrates; vaults visible; old routes 410",
    mode: "upgrade",
    acceptance: ["E2E-12", "DP-1", "SEC-6"],
    requires: ["pre_vaults_fixture", "vaults_api", "legacy_routes_removed"],
    run: async (_context, run) => {
      run.notImplemented(
        "start a stack at main 2a9c807f, load pre-vaults-fixture.sql (W6), stop, switch to the integration SHA, db:migrate, start, then check vaults in the UI and 410 on legacy routes",
      );
    },
  },
];

export function selectScenarios(spec: string | undefined): Scenario[] {
  if (!spec || spec === "all") return SCENARIOS;
  const wanted = spec.split(",").map((part) => part.trim().toUpperCase());
  const selected = SCENARIOS.filter((scenario) =>
    wanted.some((pattern) =>
      pattern.endsWith("*")
        ? scenario.id.startsWith(pattern.slice(0, -1))
        : scenario.id === pattern,
    ),
  );
  if (selected.length === 0) throw new Error(`no scenario matches ${spec}`);
  return selected;
}

export async function runScenario(
  scenario: Scenario,
  context: ScenarioContext,
): Promise<ScenarioResult> {
  const started = Date.now();
  const dir = join(context.evidenceDir, scenario.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const base = {
    id: scenario.id,
    title: scenario.title,
    mode: scenario.mode,
    acceptance: scenario.acceptance,
  };
  const missing = missingFeatures(context.features, scenario.requires);
  let result: ScenarioResult;
  if (missing.length > 0) {
    result = {
      ...base,
      status: "missing_feature",
      reason: `missing: ${missing.map((probe) => `${probe.id} (${probe.detail})`).join("; ")}`,
      missing,
      checks: [],
      sessions: [],
      durationMs: Date.now() - started,
    };
  } else {
    const run = new ScenarioRun(scenario.id, dir, () => needlesFor(context.knownValues));
    let error: string | undefined;
    try {
      await scenario.run(context, run);
    } catch (caught) {
      error = (caught as Error).stack ?? String(caught);
    }
    const failed = run.checks.filter((check) => !check.ok);
    const status: ScenarioStatus = error
      ? "error"
      : failed.length > 0
        ? "failed"
        : run.incomplete
          ? "incomplete"
          : "passed";
    result = {
      ...base,
      status,
      ...(error
        ? { reason: error.split("\n")[0] }
        : failed.length > 0
          ? { reason: `failed checks: ${failed.map((check) => check.name).join("; ")}` }
          : run.incomplete
            ? { reason: `harness step not implemented yet: ${run.incomplete}` }
            : {}),
      checks: run.checks,
      sessions: run.sessions,
      durationMs: Date.now() - started,
    };
    if (error) writeFileSync(join(dir, "error.txt"), `${error}\n`);
  }
  writeFileSync(join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** Deterministic TOTP for scenario assertions (fixed clock per §16.6 when needed). */
export function expectedTotp(seed: string, at = Date.now()): string {
  return totp(seed, at);
}
