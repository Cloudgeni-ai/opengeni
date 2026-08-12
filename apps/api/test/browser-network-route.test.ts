import { describe, expect, test } from "bun:test";
import type { NetworkRouteConsistency } from "@opengeni/contracts";
import { managedNetworkRouteForPlacement } from "../src/browser-network-route";

const consistency: NetworkRouteConsistency = {
  dns: "provider",
  expectedPublicIp: null,
  expectedRegion: "NO",
  locale: "nb-NO",
  timezone: "Europe/Oslo",
  geolocation: { latitude: 59.9139, longitude: 10.7522, accuracyMeters: 25 },
  webRtc: "disable_non_proxied_udp",
  stability: "session",
};

describe("managedNetworkRouteForPlacement", () => {
  test("resolves exact Kernel and Browserbase provider selectors", () => {
    expect(
      managedNetworkRouteForPlacement(
        {
          kind: "managed",
          providerId: "kernel",
          routeId: "kernel-proxy-4",
          egressClass: "isp",
          region: "NO",
          credential: null,
        },
        consistency,
        { kind: "external_provider", providerId: "kernel", placementId: "default" },
      ),
    ).toEqual({
      providerId: "kernel",
      routeId: "kernel-proxy-4",
      egressClass: "isp",
      region: "NO",
    });
    expect(
      managedNetworkRouteForPlacement(
        {
          kind: "managed",
          providerId: "browserbase",
          routeId: "default",
          egressClass: "residential",
          region: "NO",
          credential: null,
        },
        consistency,
        { kind: "external_provider", providerId: "browserbase", placementId: "default" },
      ),
    ).toEqual({
      providerId: "browserbase",
      routeId: "default",
      egressClass: "residential",
      region: "NO",
    });
  });

  test("rejects mismatched placement, secret duplication, and unsupported guarantees", () => {
    const kernel = {
      kind: "managed" as const,
      providerId: "kernel",
      routeId: "kernel-proxy-4",
      egressClass: "isp" as const,
      region: "NO",
      credential: null,
    };
    expect(() =>
      managedNetworkRouteForPlacement(kernel, consistency, {
        kind: "sandbox_group",
        sandboxGroupId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow("external browser provider placement");
    expect(() =>
      managedNetworkRouteForPlacement(kernel, consistency, {
        kind: "external_provider",
        providerId: "browserbase",
        placementId: "default",
      }),
    ).toThrow("another external browser provider");
    expect(() =>
      managedNetworkRouteForPlacement(
        {
          ...kernel,
          credential: {
            connectionId: "22222222-2222-4222-8222-222222222222",
            connectionSubjectId: null,
            providerDomain: "proxy.example.test",
          },
        },
        consistency,
        { kind: "external_provider", providerId: "kernel", placementId: "default" },
      ),
    ).toThrow("separate proxy credential");
    expect(() =>
      managedNetworkRouteForPlacement(
        kernel,
        { ...consistency, dns: "proxy" },
        {
          kind: "external_provider",
          providerId: "kernel",
          placementId: "default",
        },
      ),
    ).toThrow("provider DNS");
    expect(() =>
      managedNetworkRouteForPlacement(
        {
          ...kernel,
          providerId: "browserbase",
          routeId: "default",
          egressClass: "residential",
          region: "Europe/Oslo",
        },
        consistency,
        { kind: "external_provider", providerId: "browserbase", placementId: "default" },
      ),
    ).toThrow("two-letter country code");
    expect(() =>
      managedNetworkRouteForPlacement(
        {
          ...kernel,
          providerId: "browserbase",
          routeId: "default",
          egressClass: "residential",
        },
        { ...consistency, stability: "sticky" },
        { kind: "external_provider", providerId: "browserbase", placementId: "default" },
      ),
    ).toThrow("stable IP across sessions");
  });
});
