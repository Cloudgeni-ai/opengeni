import { describe, expect, test } from "bun:test";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import type { ChannelASession } from "../src/sandbox/channel-a";
import { withProviderCommandHandle } from "../src/sandbox/provider-command-session";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";

// Modal runs every command as `/bin/sh -c <command>`. With /bin/sh deleted it
// answers each exec with exit code 128 and this text, which repeats the whole
// command (observed on staging, 4 Nov 2026).
const SCRIPT = "cd /workspace && ls -la && echo unique-script-marker";
const MODAL_EXEC_ERROR = `executing processes for container: executing command "/bin/sh -c ${SCRIPT}" in sandbox: failed to load /bin/sh: no such file or directory`;

const modalProcessStart = () => import("../src/sandbox/providers/modal-process-start");

function locator(): ModalRouterProviderCommand {
  return {
    kind: "modal-router-v1",
    sandboxId: "sb-no-shell",
    taskId: "ta-test",
    execId: "1c0e3e7d-5b0e-4e2c-9a43-3a9f0d7d2c11",
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
}

/** A Modal box whose every command ends at once with `text` on stderr. */
function modalSession(text: string, exitCode: number): ChannelASession {
  const control = {
    start: async () => locator(),
    read: async (command: ModalRouterProviderCommand) => {
      const next = structuredClone(command);
      next.streams.stdout = { ...command.streams.stdout, eof: true, exitCode };
      next.streams.stderr = {
        byteOffset: command.streams.stderr.byteOffset + Buffer.byteLength(text),
        utf8Remainder: "",
        eof: true,
        exitCode,
      };
      return {
        command: next,
        expected: structuredClone(command),
        chunks: [{ stream: "stderr" as const, chunkId: `stderr:${text.length}`, text }],
        exitCode,
        streamFidelity: "separate" as const,
      };
    },
    readProbe: async () => {
      throw new Error("unused");
    },
    write: async () => {},
  };
  const session: ChannelASession = {};
  installModalCommandSession(session, control as never);
  return session;
}

describe("a Modal command whose /bin/sh cannot load", () => {
  test("the model sees what happened and what happens next, not the command dump", async () => {
    const output = await withProviderCommandHandle(1, () =>
      modalSession(MODAL_EXEC_ERROR, 128).execCommand!({ cmd: SCRIPT }),
    );
    expect(output).toContain("Process exited with code 128");
    expect(output).not.toContain("unique-script-marker");
    expect(output).not.toContain("executing processes for container");
    expect(output).toContain(
      "Modal could not start the sandbox shell: failed to load /bin/sh: no such file or directory.",
    );
    expect(output).toContain("This command did not run.");
    expect(output).toContain("replaced with a fresh one restored from /workspace");
  });

  test("ordinary output that mentions the same words is shown as it is", async () => {
    const printed = `grep found: ${MODAL_EXEC_ERROR}`;
    const output = await withProviderCommandHandle(1, () =>
      modalSession(printed, 1).execCommand!({ cmd: "grep -r failed logs" }),
    );
    expect(output).toContain(printed);
    const succeeded = await withProviderCommandHandle(1, () =>
      modalSession(MODAL_EXEC_ERROR, 0).execCommand!({ cmd: "cat saved-error.txt" }),
    );
    expect(succeeded).toContain(MODAL_EXEC_ERROR);
    // Only Modal's start failure has exit code 128 and ends with its tail.
    const otherExit = await withProviderCommandHandle(1, () =>
      modalSession(MODAL_EXEC_ERROR, 1).execCommand!({ cmd: "cat saved-error.txt; false" }),
    );
    expect(otherExit).toContain(MODAL_EXEC_ERROR);
    const followed = `${MODAL_EXEC_ERROR}\nmore log lines`;
    const printedFirst = await withProviderCommandHandle(1, () =>
      modalSession(followed, 128).execCommand!({ cmd: "cat saved-error.txt; exit 128" }),
    );
    expect(printedFirst).toContain(followed);
  });

  test("the classifier keeps only Modal's stable tail", async () => {
    const {
      isModalShellStartFailureMessage,
      modalShellStartFailureNotice,
      sanitizeModalShellStartFailureMessage,
    } = await modalProcessStart();
    expect(isModalShellStartFailureMessage(MODAL_EXEC_ERROR)).toBe(true);
    expect(isModalShellStartFailureMessage("bash: foo: command not found")).toBe(false);
    expect(isModalShellStartFailureMessage("sh: 1: /bin/shx: not found")).toBe(false);
    expect(sanitizeModalShellStartFailureMessage(`wrapped: ${MODAL_EXEC_ERROR}`)).toBe(
      "Modal could not start the sandbox shell: failed to load /bin/sh: no such file or directory",
    );
    expect(sanitizeModalShellStartFailureMessage("other failure")).toBe("other failure");
    expect(modalShellStartFailureNotice(`prefix\n${MODAL_EXEC_ERROR}`, 128)).toBeNull();
    // A wrapped copy of the sanitized text is still the same failure.
    expect(
      isModalShellStartFailureMessage(
        "setup failed: Modal could not start the sandbox shell: failed to load /bin/sh",
      ),
    ).toBe(true);
  });

  test("command text that contains Modal's words never becomes the kept cause", async () => {
    const { sanitizeModalShellStartFailureMessage } = await modalProcessStart();
    // Inside the repeated command, Modal escapes quotes, so only its own tail
    // after the command's closing quote is kept.
    const command = `echo \\" in sandbox: failed to load /bin/sh: TOKEN=abc123 rest`;
    const error = `executing processes for container: executing command "/bin/sh -c ${command}" in sandbox: failed to load /bin/sh: no such file or directory`;
    expect(sanitizeModalShellStartFailureMessage(error)).toBe(
      "Modal could not start the sandbox shell: failed to load /bin/sh: no such file or directory",
    );
    // A command ending in an escaped backslash still ends before Modal's tail.
    const trailing = `executing processes for container: executing command "/bin/sh -c echo \\\\" in sandbox: failed to load /bin/sh: no such file or directory`;
    expect(sanitizeModalShellStartFailureMessage(trailing)).toBe(
      "Modal could not start the sandbox shell: failed to load /bin/sh: no such file or directory",
    );
  });
});
