/**
 * DL-2 / CM-2: the hostile-value splice matrix, executed on real shells.
 *
 * Every case is spliced by `spliceShellCommand`, then run by a real shell with
 * the bindings delivered as environment variables, as the delivery adapter
 * does. No value ever appears in spliced text. The shell's stdout must equal
 * the expected bytes exactly. bash and dash run on the host; zsh and pwsh run
 * in a throwaway container (`sv-w1-shells`, built from
 * mcr.microsoft.com/powershell + zsh) or the stock PowerShell image when
 * Docker is available, and are skipped otherwise.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenizeSecretText } from "@opengeni/contracts";
import { spliceShellCommand, type ShellDialect, type ShellSpliceResult } from "../src/splice";
import { staticSecretKey } from "../src/testing";
import { parseSecretReference, referenceKey } from "@opengeni/contracts";

const VALUES: Record<string, string> = {
  H: "a'b\"c $HOME `id` $(id) \\n\\t *glob* {x,y} ;|&<> %PATH% $env:PATH ${env:PATH} ‘q’ “d” ¿é😀\nsecond 'line'\n  trailing ",
  J: "simple-value-123",
  M: '{\n  "token": "x\'y\\"z",\n  "list": [1, 2]\n}',
  G: "*",
  S: "a'b\"c $HOME `id` \\ * x",
  B: "{a,b}",
  "Team/GitHub/token": "ghp_from-three-segments",
};

type Case = { name: string; cmd: string; expected: string; skip?: string[] };

const POSIX_CASES: Case[] = [
  { name: "unquoted word", cmd: "printf %s {{secret:H}}", expected: VALUES.H! },
  { name: "double quotes", cmd: 'printf %s "{{secret:H}}"', expected: VALUES.H! },
  {
    name: "double quotes with text",
    cmd: 'printf %s "pre-{{secret:H}}-post"',
    expected: `pre-${VALUES.H}-post`,
  },
  {
    name: "single quotes with text",
    cmd: "printf %s 'pre-{{secret:H}}-post'",
    expected: `pre-${VALUES.H}-post`,
  },
  {
    name: "ANSI-C quotes",
    cmd: "printf %s $'pre\\t{{secret:H}}\\tpost'",
    expected: `pre\t${VALUES.H}\tpost`,
    skip: ["dash"],
  },
  {
    name: "unquoted adjacency",
    cmd: "printf %s pre{{secret:H}}post",
    expected: `pre${VALUES.H}post`,
  },
  {
    name: "two references",
    cmd: "printf '%s|%s' {{secret:H}} {{secret:J}}",
    expected: `${VALUES.H}|${VALUES.J}`,
  },
  {
    name: "same reference twice",
    cmd: "printf '%s|%s' {{secret:J}} \"{{secret:J}}\"",
    expected: `${VALUES.J}|${VALUES.J}`,
  },
  {
    name: "three-segment reference",
    cmd: "printf %s {{secret:Team/GitHub/token}}",
    expected: VALUES["Team/GitHub/token"]!,
  },
  {
    name: "unquoted heredoc",
    cmd: "cat <<EOF\nline {{secret:H}} end\nEOF",
    expected: `line ${VALUES.H} end\n`,
  },
  {
    name: "heredoc with command substitution",
    cmd: "cat <<EOF\nx $(printf %s {{secret:J}}) y\nEOF",
    expected: `x ${VALUES.J} y\n`,
  },
  {
    name: "quoted heredoc (rewritten unquoted)",
    cmd: "cat <<'EOF'\n{{secret:H}}\nEOF",
    expected: `${VALUES.H}\n`,
  },
  {
    name: "double-quoted heredoc delimiter (rewritten unquoted)",
    cmd: 'cat <<"EOF"\n$x {{secret:J}}\nEOF',
    expected: `$x ${VALUES.J}\n`,
  },
  {
    name: "quoted heredoc keeps $, backquotes and backslashes literal",
    cmd: "cat <<'EOF'\n$HOME `id` $(id) \\ \\$ a\\\n{{secret:S}} ${x}\nEOF\nprintf end",
    expected: `$HOME \`id\` $(id) \\ \\$ a\\\n${VALUES.S} \${x}\nend`,
  },
  {
    name: "quoted tab-stripped heredoc with escaped delimiter",
    cmd: "cat <<-\\EOF\n\t'{{secret:J}}' $y\n\tEOF",
    expected: `'${VALUES.J}' $y\n`,
  },
  {
    name: "quoted heredoc after an unquoted one on the same line",
    cmd: "cat <<A; cat <<'LONGER_DELIM'\n{{secret:J}} $a\nA\n$b {{secret:H}}\nLONGER_DELIM",
    expected: `${VALUES.J} \n$b ${VALUES.H}\n`,
  },
  {
    name: "tab-stripped heredoc",
    cmd: "cat <<-EOF\n\t{{secret:J}}\n\tEOF",
    expected: `${VALUES.J}\n`,
  },
  {
    name: "two heredocs",
    cmd: "cat <<A && cat <<'B'\n1 {{secret:J}}\nA\n2 {{secret:H}}\nB\nprintf done",
    expected: `1 ${VALUES.J}\n2 ${VALUES.H}\ndone`,
  },
  {
    name: "command substitution in double quotes",
    cmd: 'printf %s "$(printf %s {{secret:H}})"',
    expected: VALUES.H!.replace(/\n+$/, ""),
  },
  {
    name: "nested command substitution",
    cmd: 'printf %s "$(printf %s "$(printf %s \'{{secret:H}}\')")"',
    expected: VALUES.H!.replace(/\n+$/, ""),
  },
  {
    name: "backticks",
    cmd: 'x=`printf %s {{secret:S}}`; printf %s "$x"',
    expected: VALUES.S!,
  },
  {
    name: "backticks inside double quotes",
    cmd: 'printf %s "`printf %s {{secret:S}}`"',
    expected: VALUES.S!,
  },
  {
    name: "comment keeps the reference text",
    cmd: "printf ok # {{secret:Missing}}",
    expected: "ok",
  },
  {
    name: "assignment",
    cmd: 'V={{secret:H}}; printf %s "$V"',
    expected: VALUES.H!,
  },
  {
    name: "nested shell idiom (env prefix)",
    cmd: "V={{secret:H}} sh -c 'printf %s \"$V\"'",
    expected: VALUES.H!,
  },
  {
    name: "nested shell idiom (stdin)",
    cmd: 'printf %s {{secret:S}} | { IFS= read -r V; printf %s "$V"; }',
    expected: VALUES.S!,
  },
  {
    name: "JSON in single quotes",
    cmd: 'printf %s \'{"token":"{{secret:J}}","n":1}\'',
    expected: `{"token":"${VALUES.J}","n":1}`,
  },
  { name: "multi-line JSON value", cmd: "printf %s {{secret:M}}", expected: VALUES.M! },
  { name: "glob value is not expanded", cmd: "printf %s {{secret:G}}", expected: "*" },
  { name: "brace value is not expanded", cmd: "printf %s {{secret:B}}", expected: "{a,b}" },
  {
    name: "parameter default",
    cmd: "printf %s ${UNSET_W1_VAR:-{{secret:H}}}",
    expected: VALUES.H!,
  },
  {
    name: "case subject",
    cmd: "case {{secret:G}} in '*') printf star;; *) printf other;; esac",
    expected: "star",
  },
  {
    name: "escaped reference stays literal",
    cmd: "printf %s '\\{{secret:H}}'",
    expected: "{{secret:H}}",
  },
  {
    name: "multi-line script",
    cmd: "set -e\n# uses {{secret:Missing}} in a comment\nA={{secret:J}}\nprintf '%s:' \"$A\"\nprintf %s '{{secret:G}}'",
    expected: `${VALUES.J}:*`,
  },
  {
    name: "here-string",
    cmd: "cat <<< {{secret:H}}",
    expected: `${VALUES.H}\n`,
    skip: ["dash"],
  },
  {
    name: "subshell and pipeline",
    cmd: "(printf %s {{secret:H}}) | cat",
    expected: VALUES.H!,
  },
];

const POWERSHELL_CASES: Case[] = [
  { name: "expression", cmd: "[Console]::Out.Write({{secret:H}})", expected: VALUES.H! },
  {
    name: "double quotes",
    cmd: '[Console]::Out.Write("pre-{{secret:H}}-post")',
    expected: `pre-${VALUES.H}-post`,
  },
  {
    name: "single quotes rewritten",
    cmd: "[Console]::Out.Write('pre $x `n {{secret:H}} \"q\" post')",
    expected: `pre $x \`n ${VALUES.H} "q" post`,
  },
  {
    name: "single quotes with a doubled quote",
    cmd: "[Console]::Out.Write('it''s {{secret:J}}')",
    expected: `it's ${VALUES.J}`,
  },
  {
    name: "curly single quotes",
    cmd: "[Console]::Out.Write(\u2018pre {{secret:H}} \u201cx\u201d\u2019)",
    expected: `pre ${VALUES.H} \u201cx\u201d`,
  },
  {
    name: "curly double quotes",
    cmd: "[Console]::Out.Write(\u201cpre {{secret:H}}\u201d)",
    expected: `pre ${VALUES.H}`,
  },
  {
    name: "expandable here-string",
    cmd: '$s = @"\nline {{secret:H}} end\n"@\n[Console]::Out.Write($s)',
    expected: `line ${VALUES.H} end`,
  },
  {
    name: "literal here-string (rewritten expandable)",
    cmd: "$s = @'\n$x {{secret:J}}\n'@\n[Console]::Out.Write($s)",
    expected: `$x ${VALUES.J}`,
  },
  {
    name: "literal here-string keeps backticks, $() and line-initial quotes",
    cmd: "$s = @'\n\"@ `n $(Get-Date) ${env:PATH} {{secret:H}}\n'@\n[Console]::Out.Write($s)",
    expected: `"@ \`n $(Get-Date) \${env:PATH} ${VALUES.H}`,
  },
  {
    name: "subexpression",
    cmd: '[Console]::Out.Write("x$({{secret:J}})y")',
    expected: `x${VALUES.J}y`,
  },
  {
    name: "argument mode",
    cmd: "Write-Output {{secret:H}}",
    expected: `${VALUES.H}\n`,
  },
  {
    name: "argument mode adjacency",
    cmd: "Write-Output pre{{secret:J}}post",
    expected: `pre${VALUES.J}post\n`,
  },
  {
    name: "native command argument",
    cmd: "& printf %s {{secret:H}}",
    expected: VALUES.H!,
  },
  {
    name: "assignment and reuse",
    cmd: "$t = {{secret:M}}; [Console]::Out.Write($t)",
    expected: VALUES.M!,
  },
  {
    name: "JSON in single quotes",
    cmd: '[Console]::Out.Write(\'{"token":"{{secret:J}}"}\')',
    expected: `{"token":"${VALUES.J}"}`,
  },
  {
    name: "comments keep the reference text",
    cmd: "[Console]::Out.Write('ok') # {{secret:Missing}}\n<# {{secret:Missing}} #>",
    expected: "ok",
  },
  {
    name: "escaped reference stays literal",
    cmd: "[Console]::Out.Write('\\{{secret:H}}')",
    expected: "{{secret:H}}",
  },
];

function valueFor(key: string): string {
  for (const name of Object.keys(VALUES)) {
    const reference = parseSecretReference(`{{secret:${name}}}`);
    if (referenceKey(reference) === key) return VALUES[staticSecretKey(reference)]!;
  }
  throw new Error(`no test value for ${key}`);
}

function deliver(result: ShellSpliceResult): { text: string; env: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const binding of result.bindings) {
    expect(binding.literal).toBe(false);
    env[binding.envName] = valueFor(binding.key);
  }
  return { text: result.text, env };
}

function splice(cmd: string, dialect: ShellDialect): ShellSpliceResult {
  return spliceShellCommand(cmd, dialect, tokenizeSecretText(cmd));
}

function assertNoValues(text: string): void {
  for (const value of Object.values(VALUES)) {
    if (value.length > 3) expect(text.includes(value)).toBe(false);
  }
}

function runHost(shell: string, text: string, env: Record<string, string>): string {
  const result = Bun.spawnSync([shell, "-c", text], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent-home", ...env },
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${shell} exited ${result.exitCode}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function dockerImage(): string | null {
  if (Bun.which("docker") === null) return null;
  for (const image of ["sv-w1-shells:latest", "mcr.microsoft.com/powershell:latest"]) {
    const inspect = Bun.spawnSync(["docker", "image", "inspect", image], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (inspect.exitCode === 0) return image;
  }
  return null;
}

const RUNNER = `#!/bin/bash
cd /cases
for f in *.cmd; do
  i=\${f%.cmd}
  (
    for e in "$i".env.*; do
      [ -e "$e" ] || continue
      n=\${e##*.env.}
      v=$(cat "$e"; printf x)
      export "$n=\${v%x}"
    done
    c=$(cat "$f"; printf x)
    c=\${c%x}
    case "$1" in
      zsh) zsh -c "$c" ;;
      pwsh) pwsh -NoProfile -NonInteractive -Command "$c" ;;
    esac
  ) > "$i.out" 2> "$i.err"
done
`;

/** Run every case in one container; returns stdout per case index. */
function runInContainer(
  image: string,
  shell: "zsh" | "pwsh",
  cases: Array<{ text: string; env: Record<string, string> }>,
): Array<{ out: string; err: string }> {
  const dir = mkdtempSync(join(tmpdir(), "sv-w1-splice-"));
  try {
    writeFileSync(join(dir, "run.sh"), RUNNER, { mode: 0o755 });
    cases.forEach((entry, index) => {
      const id = String(index).padStart(3, "0");
      writeFileSync(join(dir, `${id}.cmd`), entry.text);
      for (const [name, value] of Object.entries(entry.env)) {
        writeFileSync(join(dir, `${id}.env.${name}`), value);
      }
    });
    const run = Bun.spawnSync(
      ["docker", "run", "--rm", "-v", `${dir}:/cases`, image, "bash", "/cases/run.sh", shell],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (run.exitCode !== 0) throw new Error(`container failed: ${run.stderr.toString()}`);
    return cases.map((_entry, index) => {
      const id = String(index).padStart(3, "0");
      return {
        out: readFileSync(join(dir, `${id}.out`), "utf8"),
        err: readFileSync(join(dir, `${id}.err`), "utf8"),
      };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("posix splice on real shells", () => {
  for (const shell of ["bash", "dash"]) {
    const available = Bun.which(shell) !== null;
    for (const entry of POSIX_CASES) {
      const run = available && !entry.skip?.includes(shell) ? test : test.skip;
      run(`${shell}: ${entry.name}`, () => {
        const spliced = splice(entry.cmd, "posix");
        assertNoValues(spliced.text);
        const delivered = deliver(spliced);
        expect(runHost(shell, delivered.text, delivered.env)).toBe(entry.expected);
      });
    }
  }

  const image = dockerImage();
  const zshImage = image === "sv-w1-shells:latest" ? image : null;
  (zshImage ? test : test.skip)(
    "zsh: every case",
    () => {
      const cases = POSIX_CASES.filter((entry) => !entry.skip?.includes("zsh"));
      const results = runInContainer(
        zshImage!,
        "zsh",
        cases.map((entry) => deliver(splice(entry.cmd, "posix"))),
      );
      const mismatches = cases.flatMap((entry, index) =>
        results[index]!.out === entry.expected
          ? []
          : [{ name: entry.name, out: results[index]!.out, err: results[index]!.err }],
      );
      expect(mismatches).toEqual([]);
    },
    120_000,
  );
});

describe("powershell splice on real pwsh", () => {
  const image = dockerImage();
  (image ? test : test.skip)(
    "pwsh: every case",
    () => {
      const spliced = POWERSHELL_CASES.map((entry) => splice(entry.cmd, "powershell"));
      for (const result of spliced) assertNoValues(result.text);
      const results = runInContainer(image!, "pwsh", spliced.map(deliver));
      const mismatches = POWERSHELL_CASES.flatMap((entry, index) =>
        results[index]!.out === entry.expected
          ? []
          : [
              {
                name: entry.name,
                spliced: spliced[index]!.text,
                out: results[index]!.out,
                err: results[index]!.err,
              },
            ],
      );
      expect(mismatches).toEqual([]);
    },
    180_000,
  );
});

describe("splice text", () => {
  test.each([
    ["printf %s {{secret:A}}", 'printf %s "${OPENGENI_SECRET_0}"'],
    ['printf %s "x{{secret:A}}"', 'printf %s "x${OPENGENI_SECRET_0}"'],
    ["printf %s 'x{{secret:A}}y'", "printf %s 'x'\"${OPENGENI_SECRET_0}\"'y'"],
    ["printf %s $'x{{secret:A}}'", "printf %s $'x'\"${OPENGENI_SECRET_0}\"$''"],
    ["cat <<E\n{{secret:A}}\nE", "cat <<E\n${OPENGENI_SECRET_0}\nE"],
    ["echo ok # {{secret:A}}", "echo ok # {{secret:A}}"],
  ])("posix %p", (input, expected) => {
    expect(splice(input, "posix").text).toBe(expected);
  });

  test.each([
    ["Write-Output {{secret:A}}", "Write-Output ${env:OPENGENI_SECRET_0}"],
    ["Write-Output 'a$b{{secret:A}}'", 'Write-Output "a`$b${env:OPENGENI_SECRET_0}"'],
    ["Write-Output 'plain'", "Write-Output 'plain'"],
  ])("powershell %p", (input, expected) => {
    expect(splice(input, "powershell").text).toBe(expected);
  });

  test("references in comments are not bound", () => {
    expect(splice("true # {{secret:A}}", "posix").bindings).toEqual([]);
    expect(splice("$true # {{secret:A}}", "powershell").bindings).toEqual([]);
  });

  test("quoted heredocs and literal here-strings become expansions", () => {
    expect(splice("cat <<'E'\n$a {{secret:A}}\nE", "posix").text).toBe(
      "cat <<E\n\\$a ${OPENGENI_SECRET_0}\nE",
    );
    expect(splice("cat <<'E'\n$a\nE", "posix").text).toBe("cat <<'E'\n$a\nE");
    expect(splice("$s = @'\n$a {{secret:A}}\n'@", "powershell").text).toBe(
      '$s = @"\n`$a ${env:OPENGENI_SECRET_0}\n"@',
    );
    expect(splice("cat <<'E'\n{{secret:A}}\nE", "posix").bindings).toEqual([
      {
        envName: "OPENGENI_SECRET_0",
        key: referenceKey(parseSecretReference("{{secret:A}}")),
        literal: false,
        sentinel: null,
      },
    ]);
  });

  test("a quoted heredoc with a non-word delimiter refuses references", () => {
    expect(() => splice("cat <<'E F'\n{{secret:A}}\nE F", "posix")).toThrow(/unsupported_shell/);
    expect(splice("cat <<'E F'\nplain\nE F", "posix").bindings).toEqual([]);
  });

  test.each(["cmd", "fish", "unknown"] as const)("%s refuses references", (dialect) => {
    expect(() => splice("echo {{secret:A}}", dialect)).toThrow(/unsupported_shell/);
    expect(splice("echo plain", dialect)).toEqual({ text: "echo plain", bindings: [] });
  });
});
