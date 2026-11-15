import { describe, expect, test } from "bun:test";
import {
  capabilityConnectEndpoint,
  capabilityConnectInputs,
} from "../src/capability-connect-inputs";

describe("capability connect-time inputs", () => {
  test("an entry declares the values its card asks for; others ask for none", () => {
    expect(capabilityConnectInputs("microsoft_dynamics")).toEqual([
      {
        id: "endpointUrl",
        label: "Environment address",
        placeholder: "https://contoso.crm4.dynamics.com",
      },
    ]);
    expect(capabilityConnectInputs("integration_definition")).toBeNull();
    expect(capabilityConnectInputs(null)).toBeNull();
    expect(capabilityConnectEndpoint(null, { endpointUrl: "https://example.com" })).toBeNull();
  });

  test("entered values become the connection's endpoint by the entry's rule", () => {
    expect(
      capabilityConnectEndpoint("microsoft_dynamics", {
        endpointUrl: " contoso.crm4.dynamics.com/main.aspx?appid=1 ",
      }),
    ).toEqual({ endpointUrl: "https://contoso.crm4.dynamics.com/api/mcp" });
    expect(capabilityConnectEndpoint("microsoft_dynamics", { endpointUrl: "  " })).toEqual({
      problem: "Enter the environment address.",
    });
    expect(
      capabilityConnectEndpoint("microsoft_dynamics", { endpointUrl: "https://example.com/mcp" }),
    ).toMatchObject({ problem: expect.stringContaining("isn't a Dynamics environment address") });
    expect(
      capabilityConnectEndpoint("microsoft_dynamics", {
        endpointUrl: "https://businesscentral.dynamics.com/opengenitest2026/Production",
      }),
    ).toMatchObject({ problem: expect.stringContaining("isn't a tenant ID or domain") });
  });
});
