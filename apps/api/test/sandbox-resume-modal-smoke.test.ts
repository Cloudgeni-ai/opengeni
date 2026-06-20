import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { createApiSandboxClient, makeResumeBoxById, type ApiSandboxSession } from "../src/sandbox/access";

// P0.4 LIVE API-DIRECT RESUME SMOKE (NEEDS-CREDS(Modal)).
//
// The first proof that the API process can touch a REAL box: construct the
// API's own agent-loop-free sandbox client from settings (createApiSandboxClient
// → @opengeni/runtime/sandbox), create + serialize a Modal box (the resume_state
// envelope the lease stores in P1.1), then deps.resumeBoxById resumes it by id
// and session.exec echoes a unique marker — IN-PROCESS, no worker, no Temporal.
// The marker must round-trip. The box is ALWAYS terminated in finally (cost).
//
// Modal creds: the active [opengeni] profile in ~/.modal.toml (the modal JS SDK
// reads it NATIVELY — no token is injected into settings or printed here). When
// no profile/token is available the smoke skips (it is not a merge blocker for
// the non-gated scope, per the implementation plan's NEEDS-CREDS protocol).

const IMAGE_TAG = process.env.OPENGENI_MODAL_SMOKE_IMAGE ?? "python:3.12-slim";
const APP_NAME = process.env.OPENGENI_MODAL_SMOKE_APP ?? "opengeni-p0-4-resume-smoke";

/**
 * Detect a usable Modal credential WITHOUT printing any secret: an active (or
 * MODAL_PROFILE-selected) profile in ~/.modal.toml, or MODAL_TOKEN_ID +
 * MODAL_TOKEN_SECRET in the environment. We only check for presence.
 */
function hasModalCredentials(): boolean {
  if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) {
    return true;
  }
  const tomlPath = join(homedir(), ".modal.toml");
  if (!existsSync(tomlPath)) {
    return false;
  }
  let toml: string;
  try {
    toml = readFileSync(tomlPath, "utf8");
  } catch {
    return false;
  }
  const wantedProfile = process.env.MODAL_PROFILE;
  // Parse just enough TOML to find a profile section that has a token_id and is
  // either `active = true` or the MODAL_PROFILE-named one. No secret is read.
  const sections = toml.split(/\n(?=\[)/);
  for (const section of sections) {
    const nameMatch = /^\[([^\]]+)\]/.exec(section.trimStart());
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const hasTokenId = /\btoken_id\s*=/.test(section);
    const isActive = /\bactive\s*=\s*true\b/.test(section);
    if (!hasTokenId) continue;
    if (wantedProfile ? name === wantedProfile : isActive) {
      return true;
    }
  }
  return false;
}

// Parse the modal session's execCommand() formatted string (agents-core
// formatExecResponse): a header block, then a literal "Output:" line, then the
// raw stdout. Mirrors the proven spike's parser (NOT a "[exit code N]" suffix).
function parseExecOutput(raw: string): string {
  const marker = "\nOutput:\n";
  const idx = raw.indexOf(marker);
  const output = idx >= 0 ? raw.slice(idx + marker.length) : raw;
  return output.replace(/\n$/, "");
}

async function execMarker(session: ApiSandboxSession, marker: string): Promise<string> {
  // printf (not echo -n): /bin/sh is dash on python:3.12-slim, whose echo
  // mishandles -n. The SDK reads `cmd` (a string) and wraps it in /bin/sh -lc.
  const cmd = `printf '%s' '${marker}'`;
  if (session.execCommand) {
    return parseExecOutput(await session.execCommand({ cmd }));
  }
  if (session.exec) {
    const result = (await session.exec({ cmd })) as { output?: string; stdout?: string };
    const text = result.output ?? result.stdout ?? "";
    return parseExecOutput(text);
  }
  throw new Error("resumed session exposes neither exec nor execCommand");
}

async function terminate(session: ApiSandboxSession | null | undefined): Promise<void> {
  if (!session) return;
  try {
    if (session.delete) {
      await session.delete();
    } else if (session.shutdown) {
      await session.shutdown();
    } else if (session.close) {
      await session.close();
    }
  } catch (error) {
    // Surface but never throw out of teardown.
    console.error(`[smoke teardown] terminate failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const credentialed = hasModalCredentials();

describe("P0.4 API-direct Modal resume smoke (NEEDS-CREDS(Modal))", () => {
  test.skipIf(!credentialed)(
    "the API resumes a real Modal box by id and execs a marker that round-trips",
    async () => {
      const settings = testSettings({
        sandboxBackend: "modal",
        modalAppName: APP_NAME,
        modalImageRef: IMAGE_TAG,
        // Keep the box alive comfortably past create→serialize→resume→exec.
        modalTimeoutSeconds: 600,
        modalIdleTimeoutSeconds: 300,
      });

      // The API's OWN sandbox client — the API-direct control-plane seam.
      const client = createApiSandboxClient(settings);
      expect(client).toBeDefined();
      expect(client!.backendId).toBe("modal");

      const resumeBoxById = makeResumeBoxById(client);

      // A unique marker so a stale box / cross-test leakage can never false-pass.
      const marker = `ogp04-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      let foundingSession: ApiSandboxSession | null = null;
      let resumedSession: ApiSandboxSession | null = null;
      try {
        // 1) Create a live box and serialize it → the resume_state envelope the
        //    lease (P1.1) persists as (resume_backend_id, resume_state). Call
        //    create/serialize as METHODS on the client (preserve `this`).
        const modalClient = client as unknown as {
          create(args?: unknown): Promise<ApiSandboxSession>;
          serializeSessionState(state: unknown): Promise<Record<string, unknown>>;
        };
        expect(typeof modalClient.create).toBe("function");
        foundingSession = await modalClient.create();
        expect(await foundingSession.running?.()).toBe(true);

        expect(typeof modalClient.serializeSessionState).toBe("function");
        const resumeState = await modalClient.serializeSessionState(foundingSession.state);
        expect(resumeState && typeof resumeState).toBe("object");

        // 2) THE API-DIRECT RESUME: deps.resumeBoxById resumes the box by id,
        //    in-process, with NO worker and NO Temporal.
        resumedSession = await resumeBoxById({ backend: "modal", resumeState });
        expect(await resumedSession.running?.()).toBe(true);

        // 3) Exec the marker on the resumed handle — proves the API can touch the
        //    real box and round-trip output.
        const echoed = await execMarker(resumedSession, marker);
        expect(echoed).toBe(marker);
      } finally {
        // ALWAYS terminate (cost). The founding handle owns the box; terminating
        // it kills the box for both handles (resume is a non-owning 2nd handle).
        await terminate(foundingSession);
        // Best-effort drop of the resumed handle too (no-op once box is dead).
        await terminate(resumedSession);
      }
    },
    180_000,
  );

  test.skipIf(credentialed)("smoke is skipped without Modal credentials (documented)", () => {
    // A visible breadcrumb in the non-credentialed run so the gated smoke is not
    // silently absent. The non-gated scope (config + deployment + import guard)
    // still proves P0.4 builds and wires correctly.
    expect(credentialed).toBe(false);
  });
});
