/**
 * Secret leak guard: Opengeni refuses to commit or push a secret value it
 * filled in for a reference earlier in this sandbox (docs/secrets.md,
 * "Keeping values out of commits").
 *
 * Every value the attempt's resolver delivers into the sandbox (commands,
 * stdin, apply_patch, run_on) becomes a ledger entry: its length, a 16-bit
 * keyed rolling hash and a keyed HMAC, never the value. Entries stay in
 * memory for the attempt and in a private ledger directory in the sandbox, so
 * later turns and sessions of the same workspace on the sandbox see them too.
 * Before a shell command that runs `git commit` or `git push`, one helper
 * replays the command's `git add` and `git commit` steps on a throwaway copy
 * of the index and prints exactly the content each commit would take, and
 * the commits a push would send, as unified diffs; every added line is
 * matched exactly against the ledger. A match refuses the command and names
 * the file and line. Nothing else is matched: no patterns, no guessing. The
 * helper has a hard deadline, and the command runs when it fails or is late.
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
/** The helper's hard deadline; past it the command runs unchecked. */
export const SECRET_LEAK_SCAN_DEADLINE_SECONDS = 15;
/**
 * The ledger directory in the sandbox, beside the attempt-scoped secret files
 * but never cleared at attempt end: it lasts as long as the sandbox's files.
 */
export const SECRET_LEDGER_DIRECTORY = "/tmp/opengeni-private/secret-ledger";

const P = 67_108_859;
/**
 * Bits of the rolling hash kept. It only finds candidates for the HMAC: a
 * short hash makes a stored entry useless for confirming a guessed value.
 */
const HASH_BITS = 16;
const HASH_MASK = (1 << HASH_BITS) - 1;
const LEDGER_FORMAT = "ogl2";
const REPO_MARKER = "OPENGENI-LEAK-REPO ";
const LEDGER_MARKER = "OPENGENI-LEAK-LEDGER";
const CONTENT_MARKER = "OPENGENI-LEAK-CONTENT";

export type SecretLedgerEntry = {
  length: number;
  /** The keyed rolling hash, truncated to HASH_BITS. */
  hash: number;
  /** Keyed HMAC-SHA256 of the text, 128 bits, hex. */
  mac: string;
  /** The reference as written, for the error message. */
  reference: string;
};

/**
 * The key every ledger entry is computed with. Derived from a server secret,
 * then scoped to one workspace (`scoped`), so a ledger read from the sandbox
 * reveals no value and other workspaces sharing a machine neither read nor
 * match its entries. Without a server secret (local development) each process
 * has its own random key and reads only its own entries.
 */
export class SecretLedgerKey {
  readonly id: string;
  private readonly key: Buffer;
  readonly base: number;

  constructor(secret: string | Uint8Array | null | undefined) {
    const material =
      secret === null || secret === undefined || secret.length === 0
        ? randomBytes(32)
        : Buffer.from(secret);
    this.key = createHmac("sha256", material).update("opengeni secret ledger v1").digest();
    this.id = this.hmac("id").subarray(0, 6).toString("hex");
    this.base = 256 + (this.hmac("base").readUInt32BE(0) % (P - 512));
  }

  private hmac(text: string): Buffer {
    return createHmac("sha256", this.key).update(text, "utf8").digest();
  }

  /** The key for one scope, such as a workspace. */
  scoped(scope: string): SecretLedgerKey {
    return new SecretLedgerKey(this.hmac(`scope\0${scope}`));
  }

  mac(text: string): string {
    return createHmac("sha256", this.key)
      .update("value\0")
      .update(text, "utf8")
      .digest()
      .subarray(0, 16)
      .toString("hex");
  }

  /** The full rolling hash; entries store only its low HASH_BITS. */
  rolling(text: string): number {
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * this.base + text.charCodeAt(index)) % P;
    }
    return hash;
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

/**
 * Ledger entries for resolved values. Only concealed fields (or fields of
 * unknown kind) are tracked: usernames, emails and URLs are ordinary text.
 * TOTP codes and file bytes are not tracked.
 */
export function secretLedgerEntriesFor(
  key: SecretLedgerKey,
  values: Iterable<ResolvedSecretValue>,
): SecretLedgerEntry[] {
  const entries: SecretLedgerEntry[] = [];
  for (const value of values) {
    if (value.material.type !== "text") continue;
    if (value.fieldKind && value.fieldKind !== "concealed") continue;
    for (const text of secretLedgerTexts(value.material.value)) {
      entries.push({
        length: text.length,
        hash: key.rolling(text) & HASH_MASK,
        mac: key.mac(text),
        reference: value.reference.raw,
      });
    }
  }
  return entries;
}

export function serializeSecretLedgerEntry(key: SecretLedgerKey, entry: SecretLedgerEntry): string {
  const reference = Buffer.from(entry.reference, "utf8").toString("base64url");
  return [LEDGER_FORMAT, key.id, entry.length, entry.hash, entry.mac, reference].join(" ");
}

/** Entries in ledger text written with `key`; other lines are ignored. */
export function parseSecretLedger(key: SecretLedgerKey, text: string): SecretLedgerEntry[] {
  const entries: SecretLedgerEntry[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(" ");
    if (parts.length !== 6 || parts[0] !== LEDGER_FORMAT || parts[1] !== key.id) continue;
    const length = Number.parseInt(parts[2]!, 10);
    const hash = Number.parseInt(parts[3]!, 10);
    const mac = parts[4]!;
    if (!Number.isSafeInteger(length) || length < SECRET_LEDGER_MIN_CHARS) continue;
    if (!Number.isSafeInteger(hash) || hash < 0 || hash > HASH_MASK) continue;
    if (!/^[0-9a-f]{32}$/u.test(mac)) continue;
    let reference: string;
    try {
      reference = Buffer.from(parts[5]!, "base64url").toString("utf8");
    } catch {
      continue;
    }
    entries.push({ length, hash, mac, reference });
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
  private readonly byLength = new Map<number, number>();
  private readonly byHash = new Map<string, SecretLedgerEntry[]>();

  constructor(
    private readonly key: SecretLedgerKey,
    entries: Iterable<SecretLedgerEntry>,
  ) {
    for (const entry of entries) {
      const hashKey = `${entry.length}:${entry.hash}`;
      const list = this.byHash.get(hashKey) ?? [];
      if (list.some((existing) => existing.mac === entry.mac)) continue;
      list.push(entry);
      this.byHash.set(hashKey, list);
      if (!this.byLength.has(entry.length)) {
        let pow = 1;
        for (let index = 1; index < entry.length; index += 1) {
          pow = (pow * key.base) % P;
        }
        this.byLength.set(entry.length, pow);
      }
    }
  }

  get size(): number {
    return this.byHash.size;
  }

  /** References whose tracked text occurs in `text` (each once). */
  match(text: string): string[] {
    const found = new Set<string>();
    for (const [length, pow] of this.byLength) {
      if (text.length < length) continue;
      let hash = 0;
      for (let index = 0; index < text.length; index += 1) {
        if (index >= length) {
          const out = text.charCodeAt(index - length);
          hash = (hash - ((out * pow) % P) + P) % P;
        }
        hash = (hash * this.key.base + text.charCodeAt(index)) % P;
        if (index + 1 < length) continue;
        const candidates = this.byHash.get(`${length}:${hash & HASH_MASK}`);
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

/** One git step of a shell command that decides what a commit or push takes. */
export type GitLeakStep =
  /** `git add`: replayed on the throwaway index. */
  | { kind: "add"; directory: string; args: string[] }
  /** `git commit`: the content it would take is printed. */
  | {
      kind: "commit";
      directory: string;
      /** `index`: staged changes; `all`: `-a`; `include`/`only`: with paths. */
      stage: "index" | "all" | "include" | "only";
      paths: string[];
    }
  /** `git push`: the commits it would send that no remote has are printed. */
  | { kind: "push"; directory: string; revisions: string[] };

/** The git steps of a command, in order; directories are relative to its start. */
export type GitLeakPlan = { steps: GitLeakStep[] };

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
    } else if (";&|()`\n".includes(char) || (char === "$" && command[index + 1] === "(")) {
      if (char === "&" && redirect) continue;
      endCommand();
    } else if ((char === "{" || char === "}") && !inWord) {
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
/** Words that run the next word as a command (after their own options). */
const COMMAND_PREFIXES = new Set(["env", "command", "exec", "time", "nice", "nohup", "sudo"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
/** Directories the helper cannot know: expansions, globs, home. */
const UNKNOWN_DIRECTORY = /[$`*?[\]~]/u;

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
]);
/** `git commit` short options whose value, if any, is attached (`-uno`). */
const COMMIT_ATTACHED_VALUE = new Set(["u", "S"]);

const PUSH_OPTIONS_WITH_VALUE = new Set([
  "--repo",
  "-o",
  "--push-option",
  "--receive-pack",
  "--exec",
]);

function joinDirectory(base: string | null, directory: string | undefined): string | null {
  if (base === null || !directory || directory.startsWith("-")) return null;
  if (UNKNOWN_DIRECTORY.test(directory)) return null;
  if (directory.startsWith("/")) return directory;
  return base === "." ? directory : `${base}/${directory}`;
}

/** What `git commit <args>` takes; null when it commits nothing or needs a person. */
function commitStep(
  directory: string,
  args: readonly string[],
): Extract<GitLeakStep, { kind: "commit" }> | null {
  let all = false;
  let include = false;
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      paths.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--dry-run" || arg === "--interactive" || arg === "--patch") return null;
    if (arg.startsWith("--pathspec-from-file")) return null;
    if (arg === "--all") all = true;
    else if (arg === "--include") include = true;
    else if (arg.startsWith("--")) {
      if (!arg.includes("=") && COMMIT_OPTIONS_WITH_VALUE.has(arg)) index += 1;
    } else if (arg.startsWith("-") && arg.length > 1) {
      const cluster = arg.slice(1);
      for (let at = 0; at < cluster.length; at += 1) {
        const flag = cluster[at]!;
        if (flag === "a") all = true;
        else if (flag === "i") include = true;
        else if (flag === "p") return null;
        if (COMMIT_ATTACHED_VALUE.has(flag)) break;
        if (COMMIT_OPTIONS_WITH_VALUE.has(`-${flag}`)) {
          // The value is the rest of the cluster, or the next word.
          if (at === cluster.length - 1) index += 1;
          break;
        }
      }
    } else {
      paths.push(arg);
    }
  }
  const stage = all ? "all" : paths.length === 0 ? "index" : include ? "include" : "only";
  return { kind: "commit", directory, stage, paths: stage === "all" ? [] : paths };
}

/** What `git push <args>` sends; null when it sends no commits. */
function pushStep(
  directory: string,
  args: readonly string[],
): Extract<GitLeakStep, { kind: "push" }> | null {
  const positional: string[] = [];
  const revisions: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--delete" || arg === "-d" || arg === "--dry-run" || arg === "-n") return null;
    if (arg === "--all" || arg === "--branches") revisions.push("--branches");
    else if (arg === "--mirror") revisions.push("--all");
    else if (arg === "--tags") revisions.push("--tags");
    else if (arg.startsWith("-")) {
      if (!arg.includes("=") && PUSH_OPTIONS_WITH_VALUE.has(arg)) index += 1;
    } else positional.push(arg);
  }
  const refspecs = positional.slice(1);
  for (const refspec of refspecs) {
    const source = refspec.replace(/^\+/u, "").split(":")[0]!;
    if (!source || source.startsWith("-") || /\s/u.test(source)) continue;
    revisions.push(source.includes("*") ? "--branches" : source);
  }
  if (refspecs.length === 0 && revisions.length === 0) revisions.push("HEAD");
  return revisions.length > 0
    ? { kind: "push", directory, revisions: [...new Set(revisions)] }
    : null;
}

function collectGitSteps(
  command: string,
  start: string,
  steps: GitLeakStep[],
  depth: number,
): void {
  let directory: string | null = start;
  for (const words of shellCommands(command)) {
    let at = 0;
    for (;;) {
      const word = words[at];
      if (word === undefined || !(ASSIGNMENT.test(word) || COMMAND_PREFIXES.has(word))) break;
      at += 1;
      if (COMMAND_PREFIXES.has(word)) while (words[at]?.startsWith("-")) at += 1;
    }
    const name = words[at];
    if (name === undefined) continue;
    const program = name.slice(name.lastIndexOf("/") + 1);
    if (program === "cd" || program === "pushd") {
      directory = joinDirectory(directory, words[at + 1]);
      continue;
    }
    if (program === "popd") {
      directory = null;
      continue;
    }
    if (SHELLS.has(program)) {
      // `bash -lc 'git commit …'` runs its script in the same directory.
      const option = words.findIndex((word, index) => index > at && /^-[a-z]*c[a-z]*$/u.test(word));
      const script = option > 0 ? words[option + 1] : undefined;
      if (script !== undefined && directory !== null && depth < 2) {
        collectGitSteps(script, directory, steps, depth + 1);
      }
      continue;
    }
    if (program !== "git") continue;
    let gitDirectory: string | null = directory;
    let index = at + 1;
    while (index < words.length && words[index]!.startsWith("-")) {
      const option = words[index]!;
      if (option === "-C") gitDirectory = joinDirectory(gitDirectory, words[index + 1]);
      // Another repository or work tree than the directory's: not checked.
      if (/^--(?:git-dir|work-tree)(?:=|$)/u.test(option)) gitDirectory = null;
      index += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
    }
    if (gitDirectory === null) continue;
    const subcommand = words[index];
    const args = words.slice(index + 1);
    if (subcommand === "add") {
      // Interactive or dry-run adds stage nothing the helper can replay.
      const skip = args.some(
        (arg) =>
          /^--(?:patch|interactive|edit|dry-run|pathspec-from-file)/u.test(arg) ||
          /^-[a-zA-Z]*[pien][a-zA-Z]*$/u.test(arg),
      );
      if (!skip) steps.push({ kind: "add", directory: gitDirectory, args });
    } else if (subcommand === "commit") {
      const step = commitStep(gitDirectory, args);
      if (step) steps.push(step);
    } else if (subcommand === "push") {
      const step = pushStep(gitDirectory, args);
      if (step) steps.push(step);
    }
  }
}

/** Null when the command runs neither `git commit` nor `git push`. */
export function gitLeakPlan(command: string): GitLeakPlan | null {
  if (!/\bgit\b/u.test(command) || !/\b(?:commit|push)\b/u.test(command)) return null;
  const steps: GitLeakStep[] = [];
  collectGitSteps(command, ".", steps, 0);
  return steps.some((step) => step.kind !== "add") ? { steps } : null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * The helper: prints the sandbox ledger, then replays the command's git steps
 * on a throwaway copy of each repository's index (the real index, work tree
 * and refs are untouched) and prints what each commit would take and each
 * push would send, as unified diffs without context. Exits early when the
 * ledger is empty and `ledgerKnown` is false. Runs under `timeout` when the
 * sandbox has it.
 */
export function gitLeakScanScript(plan: GitLeakPlan, options: { ledgerKnown: boolean }): string {
  const git = "git -c core.quotePath=false";
  const diff = "--no-color --no-ext-diff --no-textconv --text -U0 --src-prefix=a/ --dst-prefix=b/";
  const quiet = ">/dev/null 2>&1 </dev/null";
  const lines = plan.steps.map((step) => {
    const enter = `enter ${shellQuote(step.directory)}`;
    const paths = step.kind === "commit" ? ["--", ...step.paths].map(shellQuote).join(" ") : "";
    switch (step.kind) {
      case "add":
        return `${enter} && GIT_INDEX_FILE="$ix" git add ${step.args.map(shellQuote).join(" ")} ${quiet}`;
      case "push":
        return `${enter} && { printf '${REPO_MARKER}%s\\n' "$top"; ${git} log -p ${diff} --format='commit %H' ${step.revisions.map(shellQuote).join(" ")} --not --remotes 2>/dev/null; }`;
      case "commit":
        if (step.stage === "all") {
          return `${enter} && { GIT_INDEX_FILE="$ix" git add -u ${quiet}; show "$ix"; }`;
        }
        if (step.stage === "include") {
          return `${enter} && { GIT_INDEX_FILE="$ix" git add ${paths} ${quiet}; show "$ix"; }`;
        }
        if (step.stage === "only") {
          // Only the named paths, on top of HEAD; they stay staged after it.
          return `${enter} && { rm -f "$ix.only"; GIT_INDEX_FILE="$ix.only" git read-tree HEAD ${quiet}; GIT_INDEX_FILE="$ix.only" git add ${paths} ${quiet}; GIT_INDEX_FILE="$ix" git add ${paths} ${quiet}; show "$ix.only"; }`;
        }
        return `${enter} && show "$ix"`;
    }
  });
  const body = [
    `export GIT_OPTIONAL_LOCKS=0 GIT_PAGER=cat PAGER=cat GIT_TERMINAL_PROMPT=0 GIT_EDITOR=true`,
    `d=${shellQuote(SECRET_LEDGER_DIRECTORY)}`,
    `printf '%s\\n' '${LEDGER_MARKER}'`,
    `[ -d "$d" ] && find "$d" -maxdepth 1 -type f -exec cat {} + 2>/dev/null`,
    ...(options.ledgerKnown ? [] : [`[ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ] || exit 0`]),
    `printf '%s\\n' '${CONTENT_MARKER}'`,
    `start=$(pwd)`,
    `t=$(mktemp -d 2>/dev/null) || exit 0`,
    `trap 'rm -rf "$t"' EXIT`,
    `trap 'rm -rf "$t"; exit 0' HUP INT TERM`,
    // Moves into a step's directory and sets its repository and throwaway index.
    `enter() {`,
    `  cd "$start" && cd "$1" 2>/dev/null || return 1`,
    `  top=$(git rev-parse --show-toplevel 2>/dev/null) || return 1`,
    `  ix="$t/$(printf '%s' "$top" | cksum | tr ' ' _)"`,
    `  if [ ! -e "$ix.ready" ]; then`,
    `    real=$(git rev-parse --git-path index 2>/dev/null) || return 1`,
    `    if [ -f "$real" ]; then cp "$real" "$ix" || return 1; fi`,
    `    : > "$ix.ready"`,
    `  fi`,
    `}`,
    `show() {`,
    `  printf '${REPO_MARKER}%s\\n' "$top"`,
    `  GIT_INDEX_FILE="$1" ${git} diff --cached ${diff} 2>/dev/null`,
    `}`,
    `{`,
    ...lines,
    `} | head -c ${SECRET_LEAK_SCAN_MAX_BYTES}`,
    `exit 0`,
  ].join("\n");
  return [
    `if command -v timeout >/dev/null 2>&1; then`,
    `  exec timeout -k 2 ${SECRET_LEAK_SCAN_DEADLINE_SECONDS} sh -c ${shellQuote(body)}`,
    `fi`,
    body,
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
  readonly key: SecretLedgerKey;

  /**
   * `scope` (the workspace) keeps one workspace's entries apart from
   * another's on a shared machine.
   */
  constructor(key: SecretLedgerKey, scope?: string | null) {
    this.key = scope ? key.scoped(scope) : key;
  }

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
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!run) return null;
    const plan = gitLeakPlan(command);
    if (!plan) return null;
    const scan = run({
      cmd: gitLeakScanScript(plan, { ledgerKnown: this.entries.length > 0 }),
      ...(workdir ? { workdir } : {}),
    }).then(
      (result) => result?.stdout ?? null,
      () => null,
    );
    // The helper has its own deadline; this one also covers a sandbox
    // without `timeout`, and a stop request lets the command go at once.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), (SECRET_LEAK_SCAN_DEADLINE_SECONDS + 5) * 1000);
      onAbort = () => resolve(null);
      if (signal?.aborted) resolve(null);
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    let output: string | null;
    try {
      output = await Promise.race([scan, late]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
    if (output === null) return null;
    const leaks = readGitLeakScan(output, this.key, this.entries);
    return leaks.length > 0 ? secretLeakMessage(leaks) : null;
  }
}
