/**
 * Secret leak guard: Opengeni refuses to commit or push a secret value it
 * filled in for a reference earlier in this sandbox (docs/secrets.md,
 * "Keeping values out of commits").
 *
 * Every value the attempt's resolver delivers into the sandbox (commands,
 * stdin, apply_patch, run_on) becomes a ledger entry: its length, a keyed
 * rolling hash and a keyed HMAC, never the value. Entries stay in memory for
 * the attempt and in a private ledger directory in the sandbox, so later
 * turns and sessions sharing the sandbox see them too. Before a shell command
 * that runs `git commit` or `git push`, one read-only helper prints the
 * content git would take (staged changes, the changes `git add` or
 * `commit -a` would stage, and commits not on any remote) as unified diffs;
 * every added line is matched exactly against the ledger. A match refuses
 * the command and names the file and line. Nothing else is matched: no
 * patterns, no guessing.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ResolvedSecretValue, SecretResolver } from "@opengeni/contracts";

/** Shorter values are not tracked: matching them would block ordinary text. */
export const SECRET_LEDGER_MIN_CHARS = 8;
/** Each line of a multi-line value (a PEM body) is tracked from this length. */
const SECRET_LEDGER_MIN_LINE_CHARS = 16;
const PEM_BOUNDARY = /^-----(?:BEGIN|END) [A-Z0-9 ]+-----$/u;
/** Largest diff text the helper prints; content past it is not scanned. */
export const SECRET_LEAK_SCAN_MAX_BYTES = 8 * 1024 * 1024;
/** Untracked files larger than this are not scanned. */
const SECRET_LEAK_SCAN_MAX_FILE_BYTES = 2 * 1024 * 1024;
/**
 * The ledger directory in the sandbox, beside the attempt-scoped secret files
 * but never cleared at attempt end: it lasts as long as the sandbox's files.
 */
export const SECRET_LEDGER_DIRECTORY = "/tmp/opengeni-private/secret-ledger";

const P1 = 67_108_859;
const P2 = 67_108_837;
const LEDGER_FORMAT = "ogl1";
const REPO_MARKER = "OPENGENI-LEAK-REPO ";
const LEDGER_MARKER = "OPENGENI-LEAK-LEDGER";
const CONTENT_MARKER = "OPENGENI-LEAK-CONTENT";

export type SecretLedgerEntry = {
  length: number;
  h1: number;
  h2: number;
  /** Keyed HMAC-SHA256 of the text, 128 bits, hex. */
  mac: string;
  /** The reference as written, for the error message. */
  reference: string;
};

/**
 * The key every ledger entry is computed with. Derived from a server secret so
 * a ledger read from the sandbox cannot be used to test guesses of a value;
 * without one (local development) each process has its own random key and
 * reads only its own entries.
 */
export class SecretLedgerKey {
  readonly id: string;
  private readonly key: Buffer;
  readonly base1: number;
  readonly base2: number;

  constructor(secret: string | Uint8Array | null | undefined) {
    const material =
      secret === null || secret === undefined || secret.length === 0
        ? randomBytes(32)
        : Buffer.from(secret);
    this.key = createHmac("sha256", material).update("opengeni secret ledger v1").digest();
    this.id = this.hmac("id").subarray(0, 6).toString("hex");
    this.base1 = 256 + (this.hmac("base1").readUInt32BE(0) % (P1 - 512));
    this.base2 = 256 + (this.hmac("base2").readUInt32BE(0) % (P2 - 512));
  }

  private hmac(text: string): Buffer {
    return createHmac("sha256", this.key).update(text, "utf8").digest();
  }

  mac(text: string): string {
    return createHmac("sha256", this.key)
      .update("value\0")
      .update(text, "utf8")
      .digest()
      .subarray(0, 16)
      .toString("hex");
  }

  rolling(text: string): { h1: number; h2: number } {
    let h1 = 0;
    let h2 = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      h1 = (h1 * this.base1 + code) % P1;
      h2 = (h2 * this.base2 + code) % P2;
    }
    return { h1, h2 };
  }
}

const ledgerKeys = new Map<string, SecretLedgerKey>();
let processLedgerKey: SecretLedgerKey | null = null;

/** The ledger key for a server secret (one per process without one). */
export function secretLedgerKeyFor(secret: string | null | undefined): SecretLedgerKey {
  if (!secret) return (processLedgerKey ??= new SecretLedgerKey(null));
  let key = ledgerKeys.get(secret);
  if (!key) ledgerKeys.set(secret, (key = new SecretLedgerKey(secret)));
  return key;
}

/** The texts tracked for one value: the value, and each long line of a multi-line value. */
export function secretLedgerTexts(value: string): string[] {
  const texts = new Set<string>();
  const add = (text: string, min: number) => {
    if (text.length >= min && !text.includes("\n") && !text.includes("\r")) texts.add(text);
  };
  add(value, SECRET_LEDGER_MIN_CHARS);
  add(value.trim(), SECRET_LEDGER_MIN_CHARS);
  const lines = value.split(/\r?\n|\r/u);
  if (lines.length > 1) {
    for (const line of lines) {
      // `-----BEGIN … KEY-----` lines are the same in every key.
      if (!PEM_BOUNDARY.test(line.trim())) add(line.trim(), SECRET_LEDGER_MIN_LINE_CHARS);
    }
  }
  return [...texts];
}

/** Ledger entries for resolved values. TOTP codes and file bytes are not tracked. */
export function secretLedgerEntriesFor(
  key: SecretLedgerKey,
  values: Iterable<ResolvedSecretValue>,
): SecretLedgerEntry[] {
  const entries: SecretLedgerEntry[] = [];
  for (const value of values) {
    if (value.material.type !== "text") continue;
    for (const text of secretLedgerTexts(value.material.value)) {
      entries.push({
        length: text.length,
        ...key.rolling(text),
        mac: key.mac(text),
        reference: value.reference.raw,
      });
    }
  }
  return entries;
}

export function serializeSecretLedgerEntry(key: SecretLedgerKey, entry: SecretLedgerEntry): string {
  const reference = Buffer.from(entry.reference, "utf8").toString("base64url");
  return [LEDGER_FORMAT, key.id, entry.length, entry.h1, entry.h2, entry.mac, reference].join(" ");
}

/** Entries in ledger text written with `key`; other lines are ignored. */
export function parseSecretLedger(key: SecretLedgerKey, text: string): SecretLedgerEntry[] {
  const entries: SecretLedgerEntry[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(" ");
    if (parts.length !== 7 || parts[0] !== LEDGER_FORMAT || parts[1] !== key.id) continue;
    const [length, h1, h2] = parts.slice(2, 5).map((part) => Number.parseInt(part, 10));
    const mac = parts[5]!;
    if (!length || length < SECRET_LEDGER_MIN_CHARS || h1 === undefined || h2 === undefined)
      continue;
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !/^[0-9a-f]{32}$/u.test(mac)) continue;
    let reference: string;
    try {
      reference = Buffer.from(parts[6]!, "base64url").toString("utf8");
    } catch {
      continue;
    }
    entries.push({ length, h1, h2, mac, reference });
  }
  return entries;
}

/** One new ledger file holding `entries` (written privately, never appended). */
export function secretLedgerFile(
  key: SecretLedgerKey,
  entries: readonly SecretLedgerEntry[],
): { path: string; content: Uint8Array } {
  const text = entries.map((entry) => `${serializeSecretLedgerEntry(key, entry)}\n`).join("");
  return {
    path: `${SECRET_LEDGER_DIRECTORY}/${key.id}-${randomBytes(12).toString("hex")}`,
    content: new TextEncoder().encode(text),
  };
}

/** Exact matching of ledger entries in text. */
export class SecretLedgerIndex {
  private readonly byLength = new Map<number, { pow1: number; pow2: number }>();
  private readonly byHash = new Map<string, SecretLedgerEntry[]>();

  constructor(
    private readonly key: SecretLedgerKey,
    entries: Iterable<SecretLedgerEntry>,
  ) {
    for (const entry of entries) {
      const hashKey = `${entry.length}:${entry.h1}:${entry.h2}`;
      const list = this.byHash.get(hashKey) ?? [];
      if (list.some((existing) => existing.mac === entry.mac)) continue;
      list.push(entry);
      this.byHash.set(hashKey, list);
      if (!this.byLength.has(entry.length)) {
        let pow1 = 1;
        let pow2 = 1;
        for (let index = 1; index < entry.length; index += 1) {
          pow1 = (pow1 * key.base1) % P1;
          pow2 = (pow2 * key.base2) % P2;
        }
        this.byLength.set(entry.length, { pow1, pow2 });
      }
    }
  }

  get size(): number {
    return this.byHash.size;
  }

  /** References whose tracked text occurs in `text` (each once). */
  match(text: string): string[] {
    const found = new Set<string>();
    for (const [length, { pow1, pow2 }] of this.byLength) {
      if (text.length < length) continue;
      let h1 = 0;
      let h2 = 0;
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (index >= length) {
          const out = text.charCodeAt(index - length);
          h1 = (h1 - ((out * pow1) % P1) + P1) % P1;
          h2 = (h2 - ((out * pow2) % P2) + P2) % P2;
        }
        h1 = (h1 * this.key.base1 + code) % P1;
        h2 = (h2 * this.key.base2 + code) % P2;
        if (index + 1 < length) continue;
        const candidates = this.byHash.get(`${length}:${h1}:${h2}`);
        if (!candidates) continue;
        const mac = Buffer.from(this.key.mac(text.slice(index + 1 - length, index + 1)), "hex");
        for (const candidate of candidates) {
          if (timingSafeEqual(mac, Buffer.from(candidate.mac, "hex"))) {
            found.add(candidate.reference);
          }
        }
      }
    }
    return [...found];
  }
}

/** What a shell command would hand to git, read from its text. */
export type GitLeakPlan = {
  /** Directories the command runs git in (`.`, `cd <dir>`, `git -C <dir>`). */
  directories: string[];
  /** `git commit` runs: staged changes are committed. */
  commit: boolean;
  /** `git add` or `git commit -a` runs: tracked changes may be staged first. */
  stagesTracked: boolean;
  /** `git add` runs: untracked files that are not ignored may be staged first. */
  stagesUntracked: boolean;
  /** `git push` runs: commits not yet on any remote are sent. */
  push: boolean;
};

/** Split a shell command into simple commands of words (quotes removed). */
function shellCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  // The word after `>` or `<` is a redirection target, not an argument.
  let redirect = false;
  const endWord = () => {
    if (inWord) {
      if (redirect) redirect = false;
      else words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    redirect = false;
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      const stop = end < 0 ? command.length : end;
      word += command.slice(index + 1, stop);
      inWord = true;
      index = stop;
    } else if (char === '"') {
      let cursor = index + 1;
      while (cursor < command.length && command[cursor] !== '"') {
        if (command[cursor] === "\\" && cursor + 1 < command.length) cursor += 1;
        word += command[cursor];
        cursor += 1;
      }
      inWord = true;
      index = cursor;
    } else if (char === "\\" && index + 1 < command.length) {
      if (command[index + 1] !== "\n") {
        word += command[index + 1];
        inWord = true;
      }
      index += 1;
    } else if (";&|()`\n{}".includes(char) || (char === "$" && command[index + 1] === "(")) {
      if (char === "&" && redirect) continue;
      endCommand();
    } else if (char === ">" || char === "<") {
      // `2>&1` style descriptors are not words either.
      if (/^\d+$/u.test(word)) {
        word = "";
        inWord = false;
      }
      endWord();
      redirect = true;
    } else if (char === " " || char === "\t" || char === "\r") {
      endWord();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** `git commit` options whose value is the next word. */
const COMMIT_OPTIONS_WITH_VALUE = new Set([
  "-m",
  "--message",
  "-F",
  "--file",
  "-C",
  "--reuse-message",
  "-c",
  "--reedit-message",
  "--author",
  "--date",
  "--fixup",
  "--squash",
  "-t",
  "--template",
  "--cleanup",
  "--trailer",
  "--pathspec-from-file",
]);

/**
 * True when `git commit` takes tracked changes that are not staged: `-a`
 * (also inside a cluster such as `-am`), or paths named on the command line.
 */
function commitStagesTracked(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return index + 1 < args.length;
    if (arg === "--all" || arg === "--include" || arg === "--only") return true;
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && COMMIT_OPTIONS_WITH_VALUE.has(arg)) index += 1;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const cluster = arg.slice(1);
      for (let at = 0; at < cluster.length; at += 1) {
        const flag = cluster[at]!;
        if (flag === "a" || flag === "i" || flag === "o") return true;
        if (COMMIT_OPTIONS_WITH_VALUE.has(`-${flag}`)) {
          // The value is the rest of the cluster, or the next word.
          if (at === cluster.length - 1) index += 1;
          break;
        }
      }
      continue;
    }
    return true;
  }
  return false;
}

/** Null when the command runs neither `git commit` nor `git push`. */
export function gitLeakPlan(command: string): GitLeakPlan | null {
  if (!/\bgit\b/u.test(command) || !/\b(?:commit|push)\b/u.test(command)) return null;
  const plan: GitLeakPlan = {
    directories: ["."],
    commit: false,
    stagesTracked: false,
    stagesUntracked: false,
    push: false,
  };
  const addDirectory = (directory: string | undefined) => {
    if (!directory || /[$`*?[\]~]/u.test(directory)) return;
    if (!plan.directories.includes(directory)) plan.directories.push(directory);
  };
  for (const words of shellCommands(command)) {
    if (words[0] === "cd" || words[0] === "pushd") addDirectory(words[1]);
    const gitIndex = words.findIndex((word) => word === "git" || word.endsWith("/git"));
    if (gitIndex < 0) continue;
    let index = gitIndex + 1;
    while (index < words.length && words[index]!.startsWith("-")) {
      const option = words[index]!;
      if (option === "-C") addDirectory(words[index + 1]);
      index += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
    }
    const subcommand = words[index];
    const args = words.slice(index + 1);
    if (subcommand === "commit") {
      plan.commit = true;
      if (commitStagesTracked(args)) plan.stagesTracked = true;
    } else if (subcommand === "add") {
      plan.stagesTracked = true;
      plan.stagesUntracked = true;
    } else if (subcommand === "push") {
      plan.push = true;
    }
  }
  return plan.commit || plan.push ? plan : null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * The read-only helper: prints the sandbox ledger, then, for each repository
 * the command touches, the content git would take as unified diffs with no
 * context. Exits early when the ledger is empty and `ledgerKnown` is false.
 */
export function gitLeakScanScript(plan: GitLeakPlan, options: { ledgerKnown: boolean }): string {
  const git = "git -c core.quotePath=false";
  const diff = "--no-color --no-ext-diff --no-textconv --text -U0 --src-prefix=a/ --dst-prefix=b/";
  const repo = [
    `top=$(cd "$dir" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) || continue`,
    `case " $seen " in *" $top "*) continue ;; esac`,
    `seen="$seen $top"`,
    `printf '${REPO_MARKER}%s\\n' "$top"`,
    `cd "$top" || continue`,
    `${git} diff --cached ${diff} 2>/dev/null`,
    ...(plan.stagesTracked ? [`${git} diff ${diff} 2>/dev/null`] : []),
    ...(plan.stagesUntracked
      ? [
          `${git} ls-files --others --exclude-standard 2>/dev/null | while IFS= read -r f; do`,
          `  [ -f "$f" ] && [ "$(wc -c < "$f")" -le ${SECRET_LEAK_SCAN_MAX_FILE_BYTES} ] || continue`,
          `  ${git} diff --no-index ${diff} -- /dev/null "$f" 2>/dev/null`,
          `done`,
        ]
      : []),
    ...(plan.push
      ? [`${git} log -p ${diff} --format='commit %H' HEAD --not --remotes 2>/dev/null`]
      : []),
  ];
  return [
    `export GIT_OPTIONAL_LOCKS=0 GIT_PAGER=cat PAGER=cat`,
    `d=${shellQuote(SECRET_LEDGER_DIRECTORY)}`,
    `printf '%s\\n' '${LEDGER_MARKER}'`,
    `[ -d "$d" ] && find "$d" -maxdepth 1 -type f -exec cat {} + 2>/dev/null`,
    ...(options.ledgerKnown ? [] : [`[ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ] || exit 0`]),
    `printf '%s\\n' '${CONTENT_MARKER}'`,
    `start=$(pwd)`,
    `seen=""`,
    `{`,
    `for dir in ${plan.directories.map(shellQuote).join(" ")}; do`,
    `  cd "$start" || exit 0`,
    ...repo.map((line) => `  ${line}`),
    `done`,
    `} | head -c ${SECRET_LEAK_SCAN_MAX_BYTES}`,
    `exit 0`,
  ].join("\n");
}

export type SecretLeak = {
  repository: string;
  commit: string | null;
  path: string;
  line: number;
  reference: string;
};

function diffPath(raw: string): string | null {
  let path = raw.replace(/\t$/u, "");
  if (path === "/dev/null") return null;
  if (path.startsWith('"')) {
    try {
      path = JSON.parse(path) as string;
    } catch {
      path = path.slice(1, -1);
    }
  }
  return path.startsWith("b/") ? path.slice(2) : path;
}

/** The ledger lines and the leaks in the helper's output. */
export function readGitLeakScan(
  output: string,
  key: SecretLedgerKey,
  known: readonly SecretLedgerEntry[],
): SecretLeak[] {
  const ledgerStart = output.indexOf(`${LEDGER_MARKER}\n`);
  const contentStart = output.indexOf(`${CONTENT_MARKER}\n`);
  if (ledgerStart < 0) return [];
  const ledgerText =
    contentStart < 0
      ? output.slice(ledgerStart)
      : output.slice(ledgerStart, Math.max(ledgerStart, contentStart));
  const index = new SecretLedgerIndex(key, [...known, ...parseSecretLedger(key, ledgerText)]);
  if (index.size === 0 || contentStart < 0) return [];
  const leaks = new Map<string, SecretLeak>();
  let repository = "";
  let commit: string | null = null;
  let path: string | null = null;
  let newLine = 0;
  let remainingNew = 0;
  let remainingOld = 0;
  const lines = output.slice(contentStart + CONTENT_MARKER.length + 1).split("\n");
  for (const line of lines) {
    if (remainingNew > 0 || remainingOld > 0) {
      const marker = line[0];
      if (marker === "+" && remainingNew > 0) {
        if (path !== null) {
          for (const reference of index.match(line.slice(1))) {
            const leak = { repository, commit, path, line: newLine, reference };
            leaks.set(JSON.stringify(leak), leak);
          }
        }
        newLine += 1;
        remainingNew -= 1;
        continue;
      }
      if (marker === "-" && remainingOld > 0) {
        remainingOld -= 1;
        continue;
      }
      if (marker === " ") {
        newLine += 1;
        remainingNew = Math.max(0, remainingNew - 1);
        remainingOld = Math.max(0, remainingOld - 1);
        continue;
      }
      if (marker === "\\") continue;
      remainingNew = 0;
      remainingOld = 0;
    }
    if (line.startsWith(REPO_MARKER)) {
      repository = line.slice(REPO_MARKER.length);
      commit = null;
      path = null;
    } else if (/^commit [0-9a-f]{40,64}$/u.test(line)) {
      commit = line.slice(7);
      path = null;
    } else if (line.startsWith("diff --git ")) {
      path = null;
    } else if (line.startsWith("+++ ")) {
      path = diffPath(line.slice(4));
    } else if (line.startsWith("@@ ")) {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      if (!hunk) continue;
      remainingOld = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLine = Number(hunk[2]);
      remainingNew = hunk[3] === undefined ? 1 : Number(hunk[3]);
    } else if (line === "\\ No newline at end of file") {
      continue;
    }
  }
  return [...leaks.values()];
}

const MAX_LISTED_LEAKS = 10;

/** The model-facing refusal. */
export function secretLeakMessage(leaks: readonly SecretLeak[]): string {
  const listed = leaks.slice(0, MAX_LISTED_LEAKS).map((leak) => {
    const where = `${leak.path} line ${leak.line}`;
    const commit = leak.commit ? ` in commit ${leak.commit.slice(0, 12)}` : "";
    const repository = leak.repository ? ` (repository ${leak.repository})` : "";
    return `- ${where}${commit}${repository} holds the value of ${leak.reference}`;
  });
  if (leaks.length > MAX_LISTED_LEAKS) {
    listed.push(`- and ${leaks.length - MAX_LISTED_LEAKS} more`);
  }
  return [
    "Nothing was run: this command would commit or push a secret value that Opengeni filled in for a reference.",
    ...listed,
    "Replace each value with a placeholder, or with the reference written literally as \\{{secret:…}}; the backslash keeps a reference as text in files as well as commands. Remove a value that is already in a commit from that commit (for example with git commit --amend) before pushing. If a file is not meant to be committed, leave it unstaged or add it to .gitignore.",
  ].join("\n");
}

/** Runs the read-only POSIX shell helper in the sandbox; null when it cannot. */
export type SecretLeakGuardRunner = (input: {
  cmd: string;
  workdir?: string;
}) => Promise<{ stdout: string; exitCode: number | null } | null>;

/** Writes one private file (0600) in the sandbox. */
export type SecretLedgerWriter = (file: { path: string; content: Uint8Array }) => Promise<void>;

/**
 * One attempt's guard. `wrapResolver` records every value the attempt
 * delivers into the sandbox; `flush` stores new entries in the sandbox
 * ledger; `check` refuses a git commit or push that would carry one.
 * Failures to read or write the sandbox never fail the agent's call: the
 * guard then falls back to the entries held in memory, or lets it run.
 */
export class SecretLeakGuard {
  private readonly entries: SecretLedgerEntry[] = [];
  private pending: SecretLedgerEntry[] = [];

  constructor(readonly key: SecretLedgerKey) {}

  wrapResolver(resolver: SecretResolver): SecretResolver {
    return {
      principal: resolver.principal,
      enabled: resolver.enabled,
      resolve: async (refs, use) => {
        const values = await resolver.resolve(refs, use);
        this.record(values.values());
        return values;
      },
    };
  }

  record(values: Iterable<ResolvedSecretValue>): void {
    const known = new Set(this.entries.map((entry) => entry.mac));
    for (const entry of secretLedgerEntriesFor(this.key, values)) {
      if (known.has(entry.mac)) continue;
      known.add(entry.mac);
      this.entries.push(entry);
      this.pending.push(entry);
    }
  }

  /** Store entries not yet in the sandbox ledger. */
  async flush(write: SecretLedgerWriter | null): Promise<void> {
    if (!write || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    try {
      await write(secretLedgerFile(this.key, batch));
    } catch {
      this.pending.push(...batch);
    }
  }

  /** The refusal for a command that would commit or push a tracked value, or null. */
  async check(
    command: string,
    run: SecretLeakGuardRunner | null,
    workdir?: string,
  ): Promise<string | null> {
    if (!run) return null;
    const plan = gitLeakPlan(command);
    if (!plan) return null;
    let output: string;
    try {
      const result = await run({
        cmd: gitLeakScanScript(plan, { ledgerKnown: this.entries.length > 0 }),
        ...(workdir ? { workdir } : {}),
      });
      if (!result) return null;
      output = result.stdout;
    } catch {
      return null;
    }
    const leaks = readGitLeakScan(output, this.key, this.entries);
    return leaks.length > 0 ? secretLeakMessage(leaks) : null;
  }
}
