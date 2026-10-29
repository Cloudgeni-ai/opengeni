/**
 * Plain words for a shell command.
 *
 * A command row reads as what the command did ("Downloaded report.json",
 * "Read notes.md", "Ran make_chart.py") instead of the command itself. The
 * command stays one click away in the row's body. This is a best-effort,
 * display-only reading of the command text: anything it can't place falls back
 * to "Ran a command", and nothing here runs or changes the command.
 */

import type { OpenGeniText } from "../messages/runtime";
import { toolDisplayName } from "./tool-display-name";
import { toolStepLabel, type ToolStepPhase } from "./tool-steps";

/* ---- signed links ---------------------------------------------------------- */

/**
 * Parameters whose value is a credential: storage signatures (Azure SAS, S3,
 * Google Cloud Storage, CloudFront) and access tokens, keys and codes.
 */
const SECRET_PARAM_NAMES =
  "sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|googleaccessid|key-pair-id|policy|token|access_token|id_token|refresh_token|auth_token|client_secret|api_key|apikey|key|code|password|secret";
/**
 * What can stand before a parameter: `?`, `&`, `#`, `;`, and the same
 * separators escaped in JSON (`\u0026`), HTML (`&amp;`) or a link nested in
 * another link (`%26`, `%3F`, `%23`).
 */
const PARAM_SEPARATOR = String.raw`(?:[?&#;]|\\+u0026|&amp;|%26|%3[Ff]|%23)`;
const PARAM_EQUALS = String.raw`(?:=|%3[Dd])`;
/** A parameter value: runs until the next separator, quote, space or bracket. */
const PARAM_VALUE = String.raw`(?:\\\/|(?!%26)[^&\s'"\x60<>#\\,;()[\]{}|])+`;
const SECRET_PARAM_SOURCE = `(${PARAM_SEPARATOR})(${SECRET_PARAM_NAMES})(${PARAM_EQUALS})(${PARAM_VALUE})`;
const HAS_SECRET_PARAM = new RegExp(SECRET_PARAM_SOURCE, "i");
/**
 * `Authorization: Bearer …`, `Basic …` and `token …` credentials. The value must
 * look like a token (a digit or token punctuation in it), so prose such as
 * "Basic configuration" is left alone.
 */
const AUTH_HEADER_VALUE =
  /\b([Bb]earer|Basic|(?<=[Aa]uthorization:\s*)token)(\s+)((?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,})/g;

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()]+/gi;

/** Replaces the query of a signed or token-bearing link, so the credential is never shown. */
export const SIGNED_LINK_QUERY_PLACEHOLDER = "?[signature hidden]";
const SIGNED_LINK_FRAGMENT_PLACEHOLDER = "#[signature hidden]";
/** Replaces a credential value found outside a whole link. */
const SECRET_VALUE_PLACEHOLDER = "[hidden]";
/** Values this short are too likely to be ordinary words to hide everywhere they occur. */
const MIN_SPREAD_VALUE_LENGTH = 8;

/**
 * The credential values in `text` (signature, token and key parameter values,
 * `Bearer` tokens), raw and URL-decoded, so the same value can be hidden
 * wherever else it shows up, such as in a command's output.
 */
export function signedValues(text: string): string[] {
  const values = new Set<string>();
  const add = (value: string) => {
    if (value.length < MIN_SPREAD_VALUE_LENGTH) return;
    values.add(value);
    try {
      const decoded = decodeURIComponent(value);
      if (decoded.length >= MIN_SPREAD_VALUE_LENGTH) values.add(decoded);
    } catch {
      // Not URL-encoded.
    }
  };
  for (const match of text.matchAll(new RegExp(SECRET_PARAM_SOURCE, "gi"))) add(match[4]!);
  for (const match of text.matchAll(AUTH_HEADER_VALUE)) add(match[3]!);
  return [...values];
}

function redactLink(url: string): string {
  const cut = url.search(/[?#]/);
  if (cut < 0) return url;
  // A trailing backslash belongs to an escaped quote in JSON text, not the link.
  const trailing = /\\+$/.exec(url)?.[0] ?? "";
  const tail = url.slice(cut, url.length - trailing.length);
  if (!HAS_SECRET_PARAM.test(tail)) return url;
  const placeholder =
    url[cut] === "?" ? SIGNED_LINK_QUERY_PLACEHOLDER : SIGNED_LINK_FRAGMENT_PLACEHOLDER;
  return `${url.slice(0, cut)}${placeholder}${trailing}`;
}

/**
 * Hide every credential in `text`, whatever shape it takes: a signed or
 * token-bearing link loses its query or fragment (keeping the host and path so
 * it is still recognisable); a signature, token or key parameter anywhere else
 * (`GET /a.json?sv=…&sig=…`, `\u0026token=…` in JSON, `#access_token=…`) and an
 * `Authorization` token keep their name and lose their value; and any of
 * `values` (see `signedValues`, by default those found in `text`) is hidden
 * wherever it occurs. Text without credentials is returned unchanged.
 */
export function redactSignedUrls(
  text: string,
  values: readonly string[] = signedValues(text),
): string {
  let out = text.includes("://") ? text.replace(URL_PATTERN, redactLink) : text;
  out = out.replace(
    new RegExp(SECRET_PARAM_SOURCE, "gi"),
    (_match, separator: string, name: string, equals: string) =>
      `${separator}${name}${equals}${SECRET_VALUE_PLACEHOLDER}`,
  );
  out = out.replace(
    AUTH_HEADER_VALUE,
    (_match, scheme: string, space: string) => `${scheme}${space}${SECRET_VALUE_PLACEHOLDER}`,
  );
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (out.includes(value)) out = out.split(value).join(SECRET_VALUE_PLACEHOLDER);
  }
  return out;
}

/* ---- shell reading ---------------------------------------------------------- */

type Redirect = { op: string; target: string };
type SimpleCommand = {
  words: string[];
  redirects: Redirect[];
  heredoc: boolean;
  /** The first command of this command's pipeline (itself when it starts one). */
  pipelineHead: SimpleCommand | null;
};

// `<<EOF` and `<<-'EOF'`, but not a `<<<` here-string.
const HEREDOC = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g;

/** Drop here-document bodies (inline scripts and file contents) and keep the command lines. */
function stripHeredocBodies(source: string): string {
  const lines = source.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const delimiters = [...line.matchAll(HEREDOC)].map((match) => match[2]!);
    kept.push(line);
    for (const delimiter of delimiters) {
      while (index + 1 < lines.length && lines[index + 1]!.trim() !== delimiter) index++;
      index++;
    }
  }
  return kept.join("\n");
}

type Token = { word: string } | { op: string };

/** Split shell text into words and operators, honouring quotes and `$(…)`. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) tokens.push({ word });
    word = "";
    inWord = false;
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "'") {
      const end = source.indexOf("'", i + 1);
      word += source.slice(i + 1, end < 0 ? undefined : end);
      inWord = true;
      i = end < 0 ? source.length : end;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\" && j + 1 < source.length) j++;
        word += source[j];
        j++;
      }
      inWord = true;
      i = j;
    } else if (ch === "\\") {
      if (source[i + 1] === "\n") i++;
      else {
        word += source[i + 1] ?? "";
        inWord = true;
        i++;
      }
    } else if (ch === "$" && source[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < source.length; j++) {
        if (source[j] === "(") depth++;
        else if (source[j] === ")" && --depth === 0) break;
      }
      word += source.slice(i, j + 1);
      inWord = true;
      i = j;
    } else if (ch === "`") {
      const end = source.indexOf("`", i + 1);
      word += source.slice(i, end < 0 ? undefined : end + 1);
      inWord = true;
      i = end < 0 ? source.length : end;
    } else if (ch === "#" && !inWord) {
      while (i + 1 < source.length && source[i + 1] !== "\n") i++;
    } else if (ch === " " || ch === "\t") {
      flush();
    } else if (ch === "\n" || ch === ";" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      if ((ch === "{" || ch === "}") && inWord) {
        word += ch;
        continue;
      }
      flush();
      tokens.push({ op: ";" });
    } else if (ch === "&" || ch === "|") {
      if (ch === "&" && source[i + 1] === ">") {
        flush();
        tokens.push({ op: ">" });
        i += source[i + 2] === ">" ? 2 : 1;
        continue;
      }
      flush();
      const double = source[i + 1] === ch;
      tokens.push({ op: double ? ";" : ch === "|" ? "|" : ";" });
      if (double) i++;
    } else if (ch === ">" || ch === "<") {
      // A file descriptor number right before the operator belongs to it (`2>`).
      let fd = "";
      if (inWord && /^\d+$/.test(word)) {
        fd = word;
        word = "";
        inWord = false;
      }
      flush();
      let op = fd + ch;
      while (source[i + 1] === ">" || source[i + 1] === "<") op += source[++i];
      if (source[i + 1] === "&") {
        // `2>&1`, `>&2`: a descriptor, not a file.
        i++;
        while (i + 1 < source.length && /[\d-]/.test(source[i + 1]!)) i++;
        continue;
      }
      tokens.push({ op });
    } else {
      word += ch;
      inWord = true;
    }
  }
  flush();
  return tokens;
}

/** Commands in source order; a command after `|` points at its pipeline's first command. */
function parseCommands(source: string): SimpleCommand[] {
  const text = stripHeredocBodies(source);
  const commands: SimpleCommand[] = [];
  const fresh = (): SimpleCommand => ({
    words: [],
    redirects: [],
    heredoc: false,
    pipelineHead: null,
  });
  let current = fresh();
  let head: SimpleCommand | null = null;
  let pendingRedirect: string | null = null;
  const end = (piped: boolean) => {
    if (current.words.length) {
      current.pipelineHead = head;
      commands.push(current);
      if (piped) head ??= current;
    }
    if (!piped) head = null;
    current = fresh();
  };
  for (const token of tokenize(text)) {
    if ("op" in token) {
      if (token.op === ";") {
        end(false);
      } else if (token.op === "|") {
        end(true);
      } else if (token.op.startsWith("<<")) {
        current.heredoc = true;
        pendingRedirect = token.op === "<<<" ? "<<<" : "<<";
      } else {
        pendingRedirect = token.op;
      }
      continue;
    }
    if (pendingRedirect) {
      current.redirects.push({ op: pendingRedirect, target: token.word });
      pendingRedirect = null;
      continue;
    }
    current.words.push(token.word);
  }
  end(false);
  return commands;
}

/* ---- reading a command ------------------------------------------------------ */

type NamedStep =
  | "read"
  | "write"
  | "edit"
  | "list"
  | "download"
  | "runScript"
  | "install"
  | "createFolder"
  | "createFile"
  | "copy"
  | "move"
  | "delete"
  | "unpack"
  | "pack"
  | "convert";

type FixedStep =
  | "readFile"
  | "writeFile"
  | "listFiles"
  | "searchFiles"
  | "runTests"
  | "installPackages"
  | "createFolderUnnamed"
  | "createFileUnnamed"
  | "copyFiles"
  | "moveFiles"
  | "deleteFiles"
  | "unpackFiles"
  | "packFiles"
  | "convertFile"
  | "checkChanges"
  | "saveChanges"
  | "uploadChanges"
  | "getChanges"
  | "queryDatabase"
  | "useGitHub"
  | "runDownloadedCode"
  | "reinstallPackages";

type Step =
  | { kind: "named"; step: NamedStep; name: string | null; weight: number }
  | { kind: "fixed"; step: FixedStep; weight: number }
  | { kind: "readFiles"; count: number; weight: number }
  | { kind: "search"; query: string | null; weight: number }
  | { kind: "host"; step: "fetch" | "send"; host: string; weight: number }
  | { kind: "code"; language: string; weight: number }
  | { kind: "tool"; name: string; weight: number }
  | { kind: "toolStep"; step: "findTools" | "checkProgress" | "wait"; weight: number };

/** What a step says when its file has no name worth showing; null falls back to "Ran a command". */
const UNNAMED: Record<NamedStep, FixedStep | "editFile" | "download" | null> = {
  read: "readFile",
  write: "writeFile",
  edit: "editFile",
  list: "listFiles",
  download: "download",
  runScript: null,
  install: "installPackages",
  createFolder: "createFolderUnnamed",
  createFile: "createFileUnnamed",
  copy: "copyFiles",
  move: "moveFiles",
  delete: "deleteFiles",
  unpack: "unpackFiles",
  pack: "packFiles",
  convert: "convertFile",
};

/**
 * Every step id a title is built from (`timeline.commandStep.<id>.<phase>`),
 * so the message catalog can check each one still has a use.
 */
export const COMMAND_STEP_IDS: ReadonlyArray<
  NamedStep | FixedStep | "readFiles" | "search" | "searchFiles" | "fetch" | "send" | "runCode"
> = [
  ...(Object.keys(UNNAMED) as NamedStep[]),
  ...(Object.values(UNNAMED).filter(
    (step): step is FixedStep => step !== null && step !== "editFile" && step !== "download",
  ) as FixedStep[]),
  "runTests",
  "checkChanges",
  "saveChanges",
  "uploadChanges",
  "getChanges",
  "queryDatabase",
  "useGitHub",
  "runDownloadedCode",
  "reinstallPackages",
  "readFiles",
  "search",
  "searchFiles",
  "fetch",
  "send",
  "runCode",
];

/** Shell plumbing that never describes the work. */
const TRIVIAL = new Set([
  "cd",
  "pushd",
  "popd",
  "export",
  "set",
  "unset",
  "source",
  ".",
  "true",
  "false",
  ":",
  "shopt",
  "trap",
  "alias",
  "umask",
  "ulimit",
  "echo",
  "printf",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "in",
  "[",
  "[[",
  "test",
  "exit",
  "return",
  "wait",
  "read",
  "local",
  "declare",
  "clear",
  "pwd",
  "date",
  "whoami",
  "which",
  "type",
  "command",
]);

const READERS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "nl",
  "bat",
  "wc",
  "pdftotext",
  "pdfinfo",
  "strings",
  "xxd",
  "hexdump",
  "file",
  "stat",
  "md5sum",
  "sha256sum",
  "column",
  "sort",
  "uniq",
  "cut",
  "jq",
  "yq",
  "csvlook",
  "exiftool",
]);

const LISTERS = new Set(["ls", "find", "tree", "du", "fd", "fdfind", "exa", "eza"]);
const SEARCHERS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
const INTERPRETERS: Record<string, string> = {
  python: "Python",
  python3: "Python",
  node: "JavaScript",
  deno: "JavaScript",
  bun: "JavaScript",
  tsx: "TypeScript",
  "ts-node": "TypeScript",
  ruby: "Ruby",
  perl: "Perl",
  php: "PHP",
  Rscript: "R",
  bash: "shell",
  sh: "shell",
  zsh: "shell",
};
const PACKAGE_MANAGERS = new Set([
  "pip",
  "pip3",
  "npm",
  "yarn",
  "pnpm",
  "bun",
  "apt",
  "apt-get",
  "brew",
  "uv",
  "cargo",
  "gem",
  "conda",
  "go",
]);
const CONVERTERS = new Set([
  "pandoc",
  "soffice",
  "libreoffice",
  "convert",
  "magick",
  "ffmpeg",
  "pdftoppm",
  "pdftocairo",
  "qpdf",
  "gs",
  "rsvg-convert",
  "inkscape",
  "wkhtmltopdf",
]);
const DATABASES = new Set(["psql", "sqlite3", "mysql", "duckdb", "clickhouse-client"]);
const TEST_RUNNERS = new Set(["pytest", "jest", "vitest", "mocha"]);

/*
 * A title never makes a deletion or running downloaded code look harmless:
 * those steps outweigh everything else a command does, so the title names them.
 */
const DOWNLOADED_CODE_WEIGHT = 100;
const DELETE_WEIGHT = 50;
/** Clearing a dependency or cache folder that a tool rebuilds is routine, not the headline. */
const REGENERABLE_DELETE_WEIGHT = 0.8;
const DOWNLOADERS = new Set(["curl", "wget", "aria2c", "fetch", "http", "https", "xh"]);
const DELETERS = new Set(["rm", "rmdir", "unlink", "trash", "shred", "srm"]);
const REGENERABLE_FOLDERS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".next",
  ".turbo",
  ".parcel-cache",
]);
const INSTALL_VALUE_FLAGS = new Set([
  "-r",
  "--requirement",
  "-c",
  "--constraint",
  "-e",
  "--editable",
  "-i",
  "--index-url",
  "--extra-index-url",
  "-t",
  "--target",
  "--prefix",
  "-f",
  "--find-links",
]);
/** `bash <(curl …)`, `sh -c "$(wget …)"`, `eval "$(curl …)"`, `source <(curl …)`. */
const RUNS_DOWNLOAD_INLINE =
  /(?:^|[\s;&|(])(?:(?:ba|z|k|da)?sh|python3?|node|perl|ruby|php|eval|source|\.)\s+(?:-\S+\s+)*["']?(?:<\(|\$\(|`)\s*(?:\S*\/)?(?:curl|wget|aria2c|xh)\b/;

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** A file or folder name worth showing, or null for globs, variables and option-like text. */
function displayName(path: string | undefined): string | null {
  if (!path) return null;
  const name = basename(redactSignedUrls(path).replace(/\?.*$/, ""));
  if (!name || name === "." || name === ".." || name === "-" || name.startsWith("-")) return null;
  if (/[$*?`{}[\]<>|]/.test(name) || /^\d+$/.test(name)) return null;
  return name.length > 48 ? `${name.slice(0, 47)}…` : name;
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname : null;
  } catch {
    return null;
  }
}

function pathOf(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

function operands(words: readonly string[], valueFlags: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") {
      out.push(...words.slice(i + 1));
      break;
    }
    if (word.startsWith("-") && word.length > 1) {
      if (valueFlags.has(word)) i++;
      continue;
    }
    out.push(word);
  }
  return out;
}

function flagValue(words: readonly string[], flags: readonly string[]): string | undefined {
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    for (const flag of flags) {
      if (word === flag) return words[i + 1];
      if (flag.startsWith("--") && word.startsWith(`${flag}=`)) return word.slice(flag.length + 1);
    }
  }
  return undefined;
}

const WRAPPERS = new Set(["sudo", "time", "nice", "nohup", "exec", "stdbuf", "caffeinate"]);

/** Drop variable assignments and wrappers (`sudo`, `timeout 30`, `npx`) in front of the program. */
function unwrap(words: readonly string[]): string[] {
  let rest = [...words];
  for (let guard = 0; guard < 8 && rest.length; guard++) {
    const first = rest[0]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) rest = rest.slice(1);
    else if (WRAPPERS.has(first)) {
      rest = rest.slice(1);
      while (rest[0]?.startsWith("-")) rest = rest.slice(1);
    } else if (first === "env") {
      rest = rest.slice(1);
      while (rest[0] && (rest[0].startsWith("-") || rest[0].includes("="))) rest = rest.slice(1);
    } else if (first === "timeout") {
      rest = rest.slice(1);
      while (rest[0]?.startsWith("-")) rest = rest.slice(1);
      rest = rest.slice(1);
    } else if (
      first === "npx" ||
      first === "bunx" ||
      first === "pnpx" ||
      (first === "bun" && rest[1] === "x")
    ) {
      rest = rest.slice(first === "bun" ? 2 : 1);
      while (rest[0]?.startsWith("-"))
        rest = rest.slice(rest[0] === "-p" || rest[0] === "--package" ? 2 : 1);
    } else if ((first === "uv" || first === "poetry" || first === "pipenv") && rest[1] === "run") {
      rest = rest.slice(2);
    } else break;
  }
  return rest;
}

function classify(command: SimpleCommand, depth: number): Step | null {
  const words = unwrap(command.words);
  if (!words.length) return null;
  const program = basename(words[0]!);
  const sub = words[1];
  // Standard output written to a file (`> out.txt`); error streams and /dev/null don't count.
  const output = command.redirects.find(
    (r) => (r.op === ">" || r.op === ">>" || r.op === "1>") && r.target !== "/dev/null",
  )?.target;
  const named = (step: NamedStep, path: string | undefined, weight: number): Step => ({
    kind: "named",
    step,
    name: displayName(path),
    weight,
  });
  const fixed = (step: FixedStep, weight: number): Step => ({ kind: "fixed", step, weight });

  // Opengeni's tool client: `ogtool call <tool>` reads as that tool.
  const toolArgs =
    program === "ogtool"
      ? words.slice(1)
      : words[1] === "codemode" && /OPENGENI|ogtool/i.test(words[0]!)
        ? words.slice(2)
        : null;
  if (toolArgs) {
    const [verb, tool] = toolArgs;
    if (verb === "call" && tool) return { kind: "tool", name: tool, weight: 5 };
    if (verb === "list" || verb === "show" || verb === "declarations") {
      return { kind: "toolStep", step: "findTools", weight: 2 };
    }
    if (verb === "read") return { kind: "toolStep", step: "checkProgress", weight: 2 };
    return null;
  }

  if (DELETERS.has(program)) {
    const paths = operands(words);
    if (paths.length && paths.every((path) => REGENERABLE_FOLDERS.has(basename(path)))) {
      return paths.length === 1
        ? named("delete", paths[0], REGENERABLE_DELETE_WEIGHT)
        : fixed("deleteFiles", REGENERABLE_DELETE_WEIGHT);
    }
    return paths.length === 1
      ? named("delete", paths[0], DELETE_WEIGHT)
      : fixed("deleteFiles", DELETE_WEIGHT);
  }
  if (program === "find") {
    const exec = words.findIndex((word) => /^-(?:exec|execdir|ok|okdir)$/.test(word));
    if (
      words.includes("-delete") ||
      (exec >= 0 && DELETERS.has(basename(unwrap(words.slice(exec + 1))[0] ?? "")))
    ) {
      return fixed("deleteFiles", DELETE_WEIGHT);
    }
  }
  if (program === "xargs" || program === "parallel") {
    const rest = words.slice(1);
    while (rest[0]?.startsWith("-")) rest.shift();
    if (DELETERS.has(basename(unwrap(rest)[0] ?? ""))) return fixed("deleteFiles", DELETE_WEIGHT);
    return null;
  }
  if (program === "git" && (sub === "clean" || sub === "rm")) {
    return fixed("deleteFiles", DELETE_WEIGHT);
  }

  if (TRIVIAL.has(program)) {
    return (program === "echo" || program === "printf") && output
      ? named("write", output, 2)
      : null;
  }
  if (program === "sleep") return { kind: "toolStep", step: "wait", weight: 0.5 };

  if (program === "curl" || program === "wget" || program === "aria2c") {
    const url = words.find((word) => /^https?:\/\//i.test(word));
    const file =
      flagValue(
        words,
        program === "wget" ? ["-O", "--output-document"] : ["-o", "--output", "-O"],
      ) ?? output;
    const remoteName =
      url && (program === "wget" || words.includes("-O") || words.includes("--remote-name"))
        ? pathOf(url)
        : undefined;
    if (file && file !== "-" && file !== "/dev/null") return named("download", file, 4);
    if (remoteName && displayName(remoteName)) return named("download", remoteName, 4);
    const host = url ? hostOf(url) : null;
    const sends =
      words.some((word) =>
        /^(?:-d|--data(?:-\w+)?|--json|-F|--form|-T|--upload-file)(?:=|$)/.test(word),
      ) || /^(?:POST|PUT|PATCH|DELETE)$/i.test(flagValue(words, ["-X", "--request"]) ?? "");
    return host ? { kind: "host", step: sends ? "send" : "fetch", host, weight: 4 } : null;
  }

  if (program === "cat") {
    if (output) return named("write", output, 3);
    const files = operands(words);
    if (!files.length) return null;
    return files.length > 1
      ? { kind: "readFiles", count: files.length, weight: 2 }
      : named("read", files[0], 2);
  }
  if (program === "tee") return named("write", operands(words)[0], 3);
  if (program === "sed" || program === "awk" || (program === "perl" && words.includes("-pi"))) {
    const inPlace = words.some((word) => /^-i/.test(word) || word === "-pi");
    const files = operands(words, new Set(["-e", "-f"]));
    const file = files.length > 1 ? files[files.length - 1] : undefined;
    if (inPlace) return named("edit", file, 3);
    return file ? named("read", file, 2) : null;
  }
  if (READERS.has(program)) {
    const files = operands(
      words,
      new Set(["-n", "-c", "--lines", "--bytes", "-d", "-f", "-k", "-t"]),
    );
    const inputs = program === "jq" || program === "yq" ? files.slice(1) : files;
    if (!inputs.length) return null;
    return inputs.length > 1
      ? { kind: "readFiles", count: inputs.length, weight: 2 }
      : named("read", inputs[0], 2);
  }
  if (LISTERS.has(program)) {
    const target = operands(
      words,
      new Set([
        "-name",
        "-iname",
        "-type",
        "-maxdepth",
        "-mindepth",
        "-path",
        "-newer",
        "-size",
        "-mtime",
        "-L",
        "-d",
        "--max-depth",
      ]),
    )[0];
    return target && target !== "." ? named("list", target, 1) : fixed("listFiles", 1);
  }
  if (SEARCHERS.has(program) || (program === "git" && sub === "grep")) {
    if (program === "rg" && words.includes("--files")) return fixed("listFiles", 1);
    const args = operands(
      program === "git" ? words.slice(1) : words,
      new Set([
        "-e",
        "-g",
        "--glob",
        "-t",
        "--type",
        "-A",
        "-B",
        "-C",
        "-m",
        "--max-count",
        "--include",
        "--exclude",
      ]),
    );
    const pattern = flagValue(words, ["-e"]) ?? args[0];
    const plain = pattern && /^[\p{L}\p{N} '’.,:@_-]{2,40}$/u.test(pattern) ? pattern : null;
    return { kind: "search", query: plain, weight: 2 };
  }
  if (program === "mkdir") {
    const dirs = operands(words, new Set(["-m"]));
    return dirs.length === 1 ? named("createFolder", dirs[0], 1) : fixed("createFolderUnnamed", 1);
  }
  if (program === "touch") {
    const files = operands(words);
    return files.length === 1 ? named("createFile", files[0], 1) : fixed("createFileUnnamed", 1);
  }
  if (program === "cp" || program === "mv" || program === "rsync" || program === "ln") {
    const paths = operands(words, new Set(["-t", "--target-directory", "-e"]));
    const step = program === "mv" ? "move" : "copy";
    if (program === "ln") return null;
    return paths.length === 2
      ? named(step, paths[0], 1.5)
      : fixed(step === "move" ? "moveFiles" : "copyFiles", 1.5);
  }
  if (program === "unzip" || program === "gunzip" || program === "bunzip2" || program === "unxz") {
    return named("unpack", operands(words, new Set(["-d"]))[0], 2);
  }
  if (program === "zip") return named("pack", operands(words)[0], 2);
  if (program === "tar" || program === "7z") {
    const flags = words.slice(1).join(" ");
    const archive =
      flagValue(words, ["-f", "--file"]) ??
      words.slice(1).find((word) => /\.(?:tar|tgz|gz|bz2|xz|zst|zip|7z)$/i.test(word));
    if (program === "7z" ? sub === "x" || sub === "e" : /(?:^|\s)-?[a-z]*x/.test(flags)) {
      return named("unpack", archive, 2);
    }
    return named("pack", archive, 2);
  }
  if (CONVERTERS.has(program)) {
    const input =
      program === "ffmpeg"
        ? flagValue(words, ["-i"])
        : operands(
            words,
            new Set([
              "-o",
              "--output",
              "--outdir",
              "--convert-to",
              "-t",
              "-f",
              "--from",
              "--to",
              "-density",
              "-resize",
              "-quality",
              "-r",
            ]),
          )[0];
    return input ? named("convert", input, 3) : fixed("convertFile", 3);
  }
  if (DATABASES.has(program)) return fixed("queryDatabase", 3);
  if (program === "gh") return fixed("useGitHub", 2);
  if (program === "git") {
    switch (sub) {
      case "status":
      case "diff":
      case "log":
      case "show":
      case "blame":
        return fixed("checkChanges", 1);
      case "commit":
        return fixed("saveChanges", 2);
      case "push":
        return fixed("uploadChanges", 2);
      case "pull":
      case "fetch":
        return fixed("getChanges", 2);
      case "clone": {
        const repo = operands(words.slice(1), new Set(["-b", "--branch", "--depth", "-o"]))[0];
        return named("download", repo?.replace(/\.git$/, ""), 3);
      }
      default:
        return null;
    }
  }
  if (
    TEST_RUNNERS.has(program) ||
    ((program === "bun" ||
      program === "npm" ||
      program === "yarn" ||
      program === "pnpm" ||
      program === "go" ||
      program === "cargo") &&
      sub === "test")
  ) {
    return fixed("runTests", 3);
  }
  if (PACKAGE_MANAGERS.has(program)) {
    const installVerb = program === "uv" && sub === "pip" ? words[2] : sub;
    if (installVerb === "ci" || (program === "uv" && installVerb === "sync")) {
      return fixed("installPackages", 3);
    }
    if (installVerb === "install" || installVerb === "add" || installVerb === "i") {
      const packages = operands(
        program === "uv" && sub === "pip" ? words.slice(2) : words.slice(1),
        INSTALL_VALUE_FLAGS,
      ).filter((word) => !/^(?:-|install$|add$|i$)/.test(word));
      return packages.length === 1 ? named("install", packages[0], 3) : fixed("installPackages", 3);
    }
    if (
      (program === "npm" || program === "yarn" || program === "pnpm" || program === "bun") &&
      sub === "run" &&
      words[2]
    ) {
      return named("runScript", words[2], 3);
    }
  }
  if (program === "pip" || program === "pip3") return null;

  const language = INTERPRETERS[program];
  if (language) {
    if (language === "shell") {
      const inline = flagValue(words, ["-c", "-lc", "-ic", "-xc", "-ec"]);
      if (inline && depth < 2) return pick(parseCommands(inline), depth + 1);
    }
    if (program === "python" || program === "python3") {
      const module = flagValue(words, ["-m"]);
      if (module === "pytest" || module === "unittest") return fixed("runTests", 3);
      if (module === "pip") {
        return classify(
          { ...command, words: ["pip", ...words.slice(words.indexOf("-m") + 2)] },
          depth,
        );
      }
      if (module) return named("runScript", module, 3);
    }
    if (program === "bun" && sub && !/\.(?:[cm]?[jt]sx?)$/.test(sub)) return null;
    const script = operands(
      words,
      new Set(["-W", "-X", "-r", "--require", "--import", "--loader"]),
    )[0];
    if (script && script !== "-" && /\.[A-Za-z0-9]+$/.test(script))
      return named("runScript", script, 3);
    const display =
      program === "bun" || program === "deno" || program === "node" ? "JavaScript" : language;
    if (command.heredoc || words.some((word) => /^-[ce]$/.test(word) || word === "-")) {
      return { kind: "code", language: display, weight: 3 };
    }
    return null;
  }
  if (/^\.{0,2}\/[\w./-]+$/.test(words[0]!)) return named("runScript", words[0], 3);
  return null;
}

/**
 * A command later in a pipeline only matters to the title when it deletes
 * (`… | xargs rm`) or runs what flows into it as a program (`curl … | sh`).
 */
function classifyPiped(command: SimpleCommand, depth: number): Step | null {
  const words = unwrap(command.words);
  const program = basename(words[0] ?? "");
  const language = INTERPRETERS[program];
  if (language) {
    // `python3 -c '…'` and `bash -lc '…'` run their own code and only read the piped text.
    // (`bash -e` only stops on errors: it still runs the piped text.)
    const inlineFlag =
      language === "shell" || language === "Python" ? /^-[a-z]*c$/ : /^-(?:e|p|-eval|-print)$/;
    const inline = words.some((word) => inlineFlag.test(word));
    const script = operands(words).find((word) => /\.[A-Za-z0-9]+$/.test(word));
    if (inline || script) return null;
    const head = command.pipelineHead;
    const headProgram = head ? basename(unwrap(head.words)[0] ?? "") : "";
    if (DOWNLOADERS.has(headProgram)) {
      return { kind: "fixed", step: "runDownloadedCode", weight: DOWNLOADED_CODE_WEIGHT };
    }
    const display =
      program === "bun" || program === "deno" || program === "node" ? "JavaScript" : language;
    return { kind: "code", language: display, weight: 3.5 };
  }
  const step = classify(command, depth);
  return step && step.weight >= DELETE_WEIGHT ? step : null;
}

function pick(commands: readonly SimpleCommand[], depth: number): Step | null {
  let best: Step | null = null;
  const reads = new Set<string>();
  let readCount = 0;
  const deletions = new Set<string>();
  let regenerableDeletion = false;
  for (const command of commands) {
    const step = command.pipelineHead ? classifyPiped(command, depth) : classify(command, depth);
    if (!step) continue;
    if (step.kind === "named" && step.step === "read" && step.name) {
      reads.add(step.name);
      readCount++;
    }
    if (step.kind === "readFiles") readCount += step.count;
    const deletes =
      (step.kind === "named" && step.step === "delete") ||
      (step.kind === "fixed" && step.step === "deleteFiles");
    if (deletes && step.weight < DELETE_WEIGHT) regenerableDeletion = true;
    else if (deletes) {
      // Several deletions read as "Deleted files", never as just the first one.
      deletions.add((step.kind === "named" && step.name) || `#${deletions.size}`);
    }
    if (!best || step.weight > best.weight) best = step;
  }
  if (!best) return null;
  if (best.weight >= DELETE_WEIGHT && best.weight < DOWNLOADED_CODE_WEIGHT && deletions.size > 1) {
    return { kind: "fixed", step: "deleteFiles", weight: best.weight };
  }
  const installs =
    (best.kind === "named" && best.step === "install") ||
    (best.kind === "fixed" && best.step === "installPackages");
  if (installs && regenerableDeletion) {
    return { kind: "fixed", step: "reinstallPackages", weight: best.weight };
  }
  if (
    (best.kind === "named" && best.step === "read" && reads.size > 1) ||
    (best.kind === "readFiles" && readCount > best.count)
  ) {
    return { kind: "readFiles", count: Math.max(reads.size, readCount), weight: best.weight };
  }
  return best;
}

/**
 * What a shell command did, in plain words and in the given phase ("Downloading
 * report.json" while it runs, "Downloaded report.json" once done), or null when
 * the command can't be placed; callers then say "Ran a command".
 */
export function commandStepTitle(
  t: OpenGeniText,
  command: string,
  phase: ToolStepPhase,
): string | null {
  if (!command.trim()) return null;
  if (RUNS_DOWNLOAD_INLINE.test(command))
    return t(`timeline.commandStep.runDownloadedCode.${phase}`);
  const step = pick(parseCommands(command), 0);
  if (!step) return null;
  switch (step.kind) {
    case "named": {
      if (step.name) return t(`timeline.commandStep.${step.step}.${phase}`, { name: step.name });
      const unnamed = UNNAMED[step.step];
      if (unnamed === null) return null;
      if (unnamed === "editFile" || unnamed === "download") return toolStepLabel(t, unnamed, phase);
      return t(`timeline.commandStep.${unnamed}.${phase}`);
    }
    case "fixed":
      return t(`timeline.commandStep.${step.step}.${phase}`);
    case "readFiles":
      return t(`timeline.commandStep.readFiles.${phase}`, { count: step.count });
    case "search":
      return step.query
        ? t(`timeline.commandStep.search.${phase}`, { query: step.query })
        : t(`timeline.commandStep.searchFiles.${phase}`);
    case "host":
      return t(`timeline.commandStep.${step.step}.${phase}`, { host: step.host });
    case "code":
      return t(`timeline.commandStep.runCode.${phase}`, { language: step.language });
    case "tool": {
      // `ogtool call interaction.browser.open` names the tool by its catalog path.
      const dotted = step.name.split(".");
      const wire = dotted.length > 1 ? `${dotted[0]}__${dotted.slice(1).join("_")}` : step.name;
      return toolDisplayName(t, wire, undefined, phase);
    }
    case "toolStep":
      return toolStepLabel(t, step.step, phase);
  }
}
