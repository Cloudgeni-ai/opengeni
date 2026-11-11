import { describe, expect, test } from "bun:test";
import type { SessionAuthorizationPort } from "@opengeni/contracts";
import { startApi, startApiSessionAuthorizationOverride, type StartApiOptions } from "../src/index";

// Contributed by Ali Ozaltin (Botel AI) in
// https://github.com/Cloudgeni-ai/opengeni/pull/2539. `startApi` is the entry an
// embedding host runs when it keeps Opengeni's own startup instead of mounting
// `createApp(deps)`. It accepted only `settings` and `observability`, so such a
// host could not bind `AppDependencies.sessionAuthorization`. The composition
// call now spreads `startApiSessionAuthorizationOverride(options)`; these tests
// pin the shapes that spread can take without starting the process (which needs
// PostgreSQL, NATS and Temporal). Request-level enforcement of a bound port is
// covered by `session-authorization-routes.test.ts` over the same dependencies.
describe("startApi session-authorization option", () => {
  const port: SessionAuthorizationPort = {
    authorizeSession: async () => ({ allowed: false, reason: "forbidden" }),
    resolveListScope: async () => ({ kind: "scoped", rootSessionIds: [], sessionIds: [] }),
  };

  test("an unset option forwards nothing, so a standalone start keeps its dependencies", () => {
    const override = startApiSessionAuthorizationOverride({});
    expect(override).toEqual({});
    expect("sessionAuthorization" in override).toBe(false);
  });

  test("a bound port reaches the composition as the same object", () => {
    const override = startApiSessionAuthorizationOverride({ sessionAuthorization: port });
    expect(override.sessionAuthorization).toBe(port);
  });

  test("an explicit null is forwarded as the host's choice, not dropped", () => {
    const override = startApiSessionAuthorizationOverride({ sessionAuthorization: null });
    expect(override).toEqual({ sessionAuthorization: null });
    expect("sessionAuthorization" in override).toBe(true);
  });

  test("startApi accepts the option on the entry a host runs", () => {
    const options: StartApiOptions = { sessionAuthorization: port };
    const entry: (options?: StartApiOptions) => Promise<unknown> = startApi;
    expect(typeof entry).toBe("function");
    expect(options.sessionAuthorization).toBe(port);
  });
});
