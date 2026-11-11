import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modalCommandArgv } from "../src/sandbox/providers/modal-command-argv";

test("run-as keeps a large quoted payload once and preserves its exact output", () => {
  if (process.platform === "win32" || !process.getuid) return;
  const payload = 'quoted " $value \\ and unicode €\n'.repeat(700);
  const cmd = `printf '%s' '${payload}'; exit 7`;
  const argv = modalCommandArgv({ cmd, runAs: String(process.getuid()) });
  expect(argv.filter((arg) => arg === cmd)).toHaveLength(1);
  expect(argv.reduce((bytes, arg) => bytes + Buffer.byteLength(arg) + 1, 0)).toBeLessThan(65_536);
  const result = Bun.spawnSync(argv);
  expect(result.exitCode).toBe(7);
  expect(result.stdout.toString()).toBe(payload);
});

test("root and sudo branches pass the original shell argv without re-expanding payloads", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "modal-argv-test-"));
  try {
    const scripts = {
      id: '#!/bin/sh\nif [ "$1" = "-u" ]; then printf "%s\\n" "$TEST_UID"; else printf "other\\n"; fi\n',
      su: '#!/bin/sh\n[ "$1" = "-s" ] && [ "$2" = "/bin/sh" ] && [ "$3" = "-c" ] && [ "$5" = "--" ] || exit 90\nscript=$4; shift 6; exec /bin/sh -c "$script" "$@"\n',
      sudo: '#!/bin/sh\n[ "$1" = "-n" ] && [ "$2" = "-u" ] && [ "$4" = "--" ] || exit 91\nshift 4; exec "$@"\n',
    };
    for (const [name, source] of Object.entries(scripts)) {
      await Bun.write(join(root, name), source);
      const { chmod } = await import("node:fs/promises");
      await chmod(join(root, name), 0o700);
    }
    for (const uid of ["0", "12345"]) {
      const cmd =
        "[[ -n \"$BASH_VERSION\" ]] && ! shopt -q login_shell && printf '%s' 'literal \"$HOME\"'; exit 7";
      const argv = modalCommandArgv({
        cmd,
        shell: "/bin/bash",
        login: false,
        runAs: 'runner"; echo injected',
      });
      const result = Bun.spawnSync(argv, {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_UID: uid },
      });
      expect(result.exitCode).toBe(7);
      expect(result.stdout.toString()).toBe('literal "$HOME"');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
