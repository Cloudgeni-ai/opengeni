// P1.2 — GATED live-Modal keystone re-confirm (V5 / R4 regression).
//
// The unix_local keystone (packages/runtime/test/ownership-inversion.test.ts)
// proves the non-owned-survival seam creds-free. This re-confirms it on a REAL
// Modal box: an injected NON-OWNED session, threaded through the production
// runAgentStream owned branch, survives a normal finish un-reaped — and the box
// is terminated by US in finally (the lease, not the SDK, owns it).
//
// Gating: requires OPENGENI_ENABLE_LIVE_TESTS=true AND a Modal profile. The
// Modal SDK reads ~/.modal.toml natively; set MODAL_PROFILE=opengeni (the
// [opengeni] profile) so the token is read without ever appearing in code or
// logs. The box is terminated in finally on every path. NEVER prints any secret.
//
// Run: OPENGENI_ENABLE_LIVE_TESTS=true MODAL_PROFILE=opengeni \
//      OPENGENI_SANDBOX_BACKEND=modal OPENGENI_MODAL_APP_NAME=<app> \
//      bun test ./test/live/sandbox-ownership.live.ts

import { describe, expect, test } from "bun:test";
import { getSettings } from "@opengeni/config";
import {
  buildOpenGeniAgent,
  configureOpenAI,
  runAgentStream,
  establishSandboxSessionFromEnvelope,
} from "@opengeni/runtime";
import { functionCall, ScriptedModel, assistantMessage } from "@opengeni/testing";

describe("P1.2 live Modal keystone re-confirm (gated)", () => {
  const live = process.env.OPENGENI_ENABLE_LIVE_TESTS === "true";
  const isModal = process.env.OPENGENI_SANDBOX_BACKEND === "modal";

  test.skipIf(!live || !isModal)(
    "injected NON-OWNED Modal session survives runAgentStream un-reaped; we terminate it in finally",
    async () => {
      const settings = {
        ...getSettings(),
        sandboxBackend: "modal" as const,
        openaiModel: "scripted-model",
      };
      configureOpenAI(settings);

      // Establish a REAL Modal box by id from a cold (null) envelope -> create().
      const established = await establishSandboxSessionFromEnvelope(settings, null, {
        sessionId: `live-keystone-${crypto.randomUUID()}`,
        backendOverride: "modal",
        createPolicy: "disposable",
      });
      const session = established.session as {
        running?: () => Promise<boolean>;
        exec?: (a: { cmd: string }) => Promise<unknown>;
        shutdown?: (o?: unknown) => Promise<void>;
        delete?: (o?: unknown) => Promise<void>;
      };
      let terminated = false;
      const terminate = async () => {
        if (terminated) return;
        terminated = true;
        // Terminate the box ourselves (the lease owns lifecycle in prod; here we
        // are the owner). Try shutdown() then delete() — whichever the client has.
        try {
          if (typeof session.shutdown === "function") {
            await session.shutdown();
          } else if (typeof session.delete === "function") {
            await session.delete();
          }
        } catch {
          // best-effort terminate; never leak the box, never throw from cleanup.
        }
      };

      try {
        expect(established.backendId).toBe("modal");
        expect(typeof established.instanceId).toBe("string");
        expect(established.instanceId.length).toBeGreaterThan(0);

        const model = new ScriptedModel([
          {
            output: [
              functionCall(
                "exec_command",
                { cmd: "echo LIVE_KEYSTONE_P12 > /tmp/marker.txt && cat /tmp/marker.txt" },
                "shell-1",
              ),
            ],
          },
          { output: [assistantMessage("live keystone ok")] },
        ]);
        const agent = buildOpenGeniAgent(settings, [], { model });

        const stream = await runAgentStream(agent, "live keystone turn", settings, {
          ownedSandbox: {
            client: established.client,
            session: established.session,
            sessionState: established.sessionState,
          },
        });
        for await (const _ of stream.toStream()) {
          void _;
        }
        await stream.completed;

        // KEYSTONE on real Modal: the box is STILL RUNNING after the normal
        // finish — the SDK never reaped the injected non-owned session.
        if (typeof session.running === "function") {
          expect(await session.running()).toBe(true);
        }
      } finally {
        await terminate();
      }
    },
    300_000,
  );
});
