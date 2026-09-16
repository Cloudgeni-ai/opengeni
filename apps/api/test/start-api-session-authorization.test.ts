import { describe, expect, test } from "bun:test";
import type { SessionAuthorizationPort } from "@opengeni/contracts";
import type { AppDependencies } from "@opengeni/core";
import { startApi, startApiSessionAuthorizationOverride, type StartApiOptions } from "../src/index";

/**
 * `startApi` is the entry an embedding host runs when it keeps OpenGeni's own
 * startup instead of mounting `createApp(deps)`. It used to accept only
 * `settings` and `observability`, so such a host could not bind
 * `AppDependencies.sessionAuthorization`. The composition call now spreads
 * `startApiSessionAuthorizationOverride(options)`; these tests pin the three
 * shapes that spread can take, without starting the process (which needs
 * PostgreSQL, NATS and Temporal). The request-level behaviour of a bound port —
 * every session-addressed surface failing closed — is the existing
 * `session-authorization-routes.test.ts` over the same `AppDependencies`.
 */
describe("startApi session-authorization option", () => {
  // A fail-closed host port: every decision denies, every listing is empty.
  const port: SessionAuthorizationPort = {
    authorizeSession: async () => ({ allowed: false, reason: "forbidden" }),
    resolveListScope: async () => ({ kind: "scoped", rootSessionIds: [], sessionIds: [] }),
  };

  test("an unset option forwards nothing, so a standalone start keeps today's dependencies", () => {
    expect(startApiSessionAuthorizationOverride({})).toEqual({});
    expect("sessionAuthorization" in startApiSessionAuthorizationOverride({})).toBe(false);
  });

  test("a bound port reaches the composition as the same object", () => {
    const override = startApiSessionAuthorizationOverride({ sessionAuthorization: port });
    expect(override).toEqual({ sessionAuthorization: port });
    expect((override as Pick<AppDependencies, "sessionAuthorization">).sessionAuthorization).toBe(
      port,
    );
  });

  test("an explicit null is forwarded as the host's choice, not dropped", () => {
    const override = startApiSessionAuthorizationOverride({ sessionAuthorization: null });
    expect(override).toEqual({ sessionAuthorization: null });
    expect("sessionAuthorization" in override).toBe(true);
  });

  test("the option is part of startApi's signature", () => {
    // Type-level: a host may pass the port on the entry it runs. Not invoked —
    // startApi opens PostgreSQL, NATS and Temporal.
    const options: StartApiOptions = { sessionAuthorization: port };
    const entry: (options?: StartApiOptions) => Promise<unknown> = startApi;
    expect(typeof entry).toBe("function");
    expect(options.sessionAuthorization).toBe(port);
  });
});
