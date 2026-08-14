import { describe, expect, test } from "bun:test";
import {
  deriveBrowserControllerAdminToken,
  deriveBrowserNetworkRouteAuthorityDigest,
  deriveBrowserSessionControllerTokens,
  deriveBrowserViewGrantToken,
  deriveComputerSessionControllerTokens,
  deriveComputerViewGrantToken,
} from "../src/browser-controller-authority";

const scope = {
  rootSecret: "deployment-root-secret",
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  placement: {
    kind: "sandbox_group" as const,
    sandboxGroupId: "33333333-3333-4333-8333-333333333333",
  },
  placementInstanceId: "provider-instance-1",
};

describe("browser controller authority derivation", () => {
  test("binds route authority to its exact snapshot and credential without exposing either", () => {
    const input = {
      rootSecret: scope.rootSecret,
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      browserSessionId: "44444444-4444-4444-8444-444444444444",
      routeId: "99999999-9999-4999-8999-999999999999",
      routeVersion: 2,
      credentialVersion: 7,
      configuration: {
        kind: "proxy" as const,
        protocol: "https" as const,
        host: "proxy.example.test",
        port: 8443,
        credential: {
          connectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          connectionSubjectId: "proxy-account",
          providerDomain: "proxy.example.test",
        },
      },
      consistency: {
        dns: "proxy" as const,
        expectedPublicIp: null,
        expectedRegion: "NO",
        locale: "nb-NO",
        timezone: "Europe/Oslo",
        geolocation: null,
        webRtc: "disable_non_proxied_udp" as const,
        stability: "sticky" as const,
      },
      proxyCredential: { username: "route-user", password: "private-route-password" },
    };
    const digest = deriveBrowserNetworkRouteAuthorityDigest(input);
    expect(digest).toMatch(/^ogr\.[A-Za-z0-9_-]{43}$/u);
    expect(deriveBrowserNetworkRouteAuthorityDigest(input)).toBe(digest);
    expect(digest).not.toContain("route-user");
    expect(digest).not.toContain("private-route-password");
    expect(
      deriveBrowserNetworkRouteAuthorityDigest({
        ...input,
        proxyCredential: { ...input.proxyCredential, password: "rotated" },
      }),
    ).not.toBe(digest);
    expect(deriveBrowserNetworkRouteAuthorityDigest({ ...input, routeVersion: 3 })).not.toBe(
      digest,
    );
  });

  test("is deterministic, domain-separated, and bound to every durable fence", () => {
    const sessionScope = {
      ...scope,
      browserSessionId: "44444444-4444-4444-8444-444444444444",
      controllerGeneration: "55555555-5555-4555-8555-555555555555",
      tokenGeneration: 1,
    };
    const first = deriveBrowserSessionControllerTokens(sessionScope);
    expect(deriveBrowserSessionControllerTokens(sessionScope)).toEqual(first);
    expect(first.controlToken).not.toBe(first.viewToken);
    expect(first.controlToken).toMatch(/^ogb\.[A-Za-z0-9_-]{43}$/u);
    expect(deriveBrowserControllerAdminToken(scope)).not.toBe(first.controlToken);
    expect(
      deriveBrowserSessionControllerTokens({ ...sessionScope, tokenGeneration: 2 }).controlToken,
    ).not.toBe(first.controlToken);
    expect(
      deriveBrowserSessionControllerTokens({
        ...sessionScope,
        placementInstanceId: "provider-instance-2",
      }).controlToken,
    ).not.toBe(first.controlToken);
  });

  test("binds frame grants to their id and exact expiry", () => {
    const input = {
      ...scope,
      browserSessionId: "44444444-4444-4444-8444-444444444444",
      controllerGeneration: "55555555-5555-4555-8555-555555555555",
      tokenGeneration: 1,
      grantId: "66666666-6666-4666-8666-666666666666",
      expiresAt: "2026-08-09T12:00:00.000Z",
    };
    const token = deriveBrowserViewGrantToken(input);
    expect(deriveBrowserViewGrantToken(input)).toBe(token);
    expect(
      deriveBrowserViewGrantToken({ ...input, expiresAt: "2026-08-09T12:00:01.000Z" }),
    ).not.toBe(token);
  });

  test("isolates computer authority from browser authority and every durable fence", () => {
    const common = {
      ...scope,
      controllerGeneration: "55555555-5555-4555-8555-555555555555",
      tokenGeneration: 1,
    };
    const browser = deriveBrowserSessionControllerTokens({
      ...common,
      browserSessionId: "44444444-4444-4444-8444-444444444444",
    });
    const computerSessionId = "77777777-7777-4777-8777-777777777777";
    const computer = deriveComputerSessionControllerTokens({ ...common, computerSessionId });

    expect(deriveComputerSessionControllerTokens({ ...common, computerSessionId })).toEqual(
      computer,
    );
    expect(computer.controlToken).not.toBe(computer.viewToken);
    expect(computer.controlToken).not.toBe(browser.controlToken);
    expect(
      deriveComputerSessionControllerTokens({
        ...common,
        computerSessionId,
        tokenGeneration: 2,
      }).controlToken,
    ).not.toBe(computer.controlToken);

    const grant = {
      ...common,
      computerSessionId,
      grantId: "88888888-8888-4888-8888-888888888888",
      expiresAt: "2026-08-10T12:00:00.000Z",
    };
    const token = deriveComputerViewGrantToken(grant);
    expect(deriveComputerViewGrantToken(grant)).toBe(token);
    expect(
      deriveComputerViewGrantToken({ ...grant, expiresAt: "2026-08-10T12:00:01.000Z" }),
    ).not.toBe(token);
  });
});
