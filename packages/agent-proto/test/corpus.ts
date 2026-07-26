/**
 * The canonical cross-stack test corpus (TypeScript side).
 *
 * These builders produce the EXACT same logical messages as the Rust corpus
 * (`agent/crates/opengeni-agent-proto/src/corpus.rs`). The round-trip test
 * encodes them in one language and decodes in the other, proving the two
 * generated stacks agree on the wire (the M0 "never drift" guarantee).
 *
 * Keep these in lock-step with the Rust corpus.
 */

import { Arch, ControlRequest, ControlResponse, Hello, Os } from "../src/index";

const textEncoder = new TextEncoder();

/** Bytes from an ASCII string literal (mirrors the Rust `b"..."` fixtures). */
function bytes(s: string): Uint8Array {
  return textEncoder.encode(s);
}

/**
 * A map-free `ControlResponse` carrying a structured git status — used for the
 * strict byte-equality cross-stack check.
 */
export function canonicalControlResponse(): ControlResponse {
  return {
    requestId: "req-0001",
    error: undefined,
    result: {
      $case: "git",
      git: {
        exitCode: 0,
        stdout: bytes("on branch main\n"),
        stderr: new Uint8Array(0),
        status: {
          branch: "main",
          upstream: "origin/main",
          ahead: 2,
          behind: 0,
          files: [
            { path: "src/lib.rs", code: " M", staged: false },
            { path: "README.md", code: "??", staged: false },
          ],
          clean: false,
        },
      },
    },
  };
}

/**
 * A richer `ControlRequest` exercising strings, a u32, an enum, repeated strings,
 * bytes, and a single-entry map (via the wrapped `ExecRequest`).
 */
export function canonicalControlRequest(): ControlRequest {
  return {
    requestId: "req-0002",
    epoch: 7,
    op: {
      $case: "exec",
      exec: {
        command: ["echo", "hello"],
        shell: false,
        cwd: "/home/user/repo",
        env: { OPENGENI_AGENT: "1" },
        stdin: bytes("piped-input"),
        timeoutMs: 5000,
      },
    },
  };
}

/**
 * A `Hello` exercising enums, a nested `Capabilities` + `Display`, and strings —
 * the connect handshake. Map-free, so also byte-equality-checkable.
 */
export function canonicalHello(): Hello {
  return {
    agentId: "agent-abc",
    workspaceId: "ws-xyz",
    agentVersion: "0.1.0",
    os: Os.OS_LINUX,
    arch: Arch.ARCH_X86_64,
    machineName: "buildbox",
    workspaceRoot: "/home/user",
    capabilities: {
      exec: true,
      filesystem: true,
      git: true,
      pty: true,
      desktop: false,
      consentedWholeMachine: true,
      consentedScreenControl: false,
      display: {
        id: ":99",
        width: 1920,
        height: 1080,
        virtual: true,
      },
      // Lock-step with the Rust corpus: exercises the desktopUnavailableReason field
      // (desktop:false + display present + reason = the capture-blocked case).
      desktopUnavailableReason: "screen recording not granted",
      // Left at the proto3 default (false) so the encoded bytes are unchanged and
      // the existing cross-stack fixtures stay valid (mirrors the Rust corpus).
      opStream: false,
    },
    updateChannel: "stable",
    resumeToken: "resume-token-1",
  };
}
