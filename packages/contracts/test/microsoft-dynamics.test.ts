import { describe, expect, test } from "bun:test";
import {
  businessCentralApiBase,
  businessCentralEnvironment,
  canonicalMcpEndpointUrl,
  dataverseWebApiBase,
  microsoftDynamicsDefaultScope,
  microsoftDynamicsAddressProblem,
  microsoftDynamicsEnvironmentAddress,
  microsoftDynamicsMcpEndpoint,
  microsoftDynamicsProductForMcpUrl,
} from "../src/microsoft-dynamics";

describe("Microsoft Dynamics MCP endpoints", () => {
  test("recognizes exact Dataverse and Finance and Operations MCP endpoints", () => {
    expect(microsoftDynamicsProductForMcpUrl("https://contoso.crm.dynamics.com/api/mcp")).toBe(
      "dataverse",
    );
    expect(microsoftDynamicsProductForMcpUrl("https://contoso.crm4.dynamics.com/api/mcp/")).toBe(
      "dataverse",
    );
    expect(
      microsoftDynamicsProductForMcpUrl("https://contoso.crm.dynamics.com/api/mcp_preview"),
    ).toBe("dataverse");
    expect(microsoftDynamicsProductForMcpUrl("https://usmf.operations.dynamics.com/mcp")).toBe(
      "finance_operations",
    );
    expect(
      microsoftDynamicsProductForMcpUrl("https://usmf-uat.sandbox.operations.dynamics.com/mcp"),
    ).toBe("finance_operations");
    expect(
      microsoftDynamicsProductForMcpUrl("https://opengeni-fno-test.operations.ch.dynamics.com/mcp"),
    ).toBe("finance_operations");
    for (const url of [
      "http://contoso.crm.dynamics.com/api/mcp",
      "https://contoso.crm.dynamics.com/",
      "https://contoso.crm.dynamics.com/api/data/v9.2",
      "https://contoso.crm.dynamics.com/api/mcp?x=1",
      "https://contoso.crm.dynamics.com:8443/api/mcp",
      "https://user@contoso.crm.dynamics.com/api/mcp",
      "https://crm.dynamics.com/api/mcp",
      "https://contoso.crm.dynamics.com.evil.test/api/mcp",
      "https://contoso.crm.microsoftdynamics.us/api/mcp",
      "https://usmf.operations.dynamics.com/api/mcp",
      "https://mcp.businesscentral.dynamics.com",
      "not a url",
    ])
      expect(microsoftDynamicsProductForMcpUrl(url)).toBeNull();
  });

  test("turns a pasted environment URL into its MCP endpoint", () => {
    expect(microsoftDynamicsMcpEndpoint("contoso.crm.dynamics.com")).toEqual({
      product: "dataverse",
      mcpUrl: "https://contoso.crm.dynamics.com/api/mcp",
    });
    expect(
      microsoftDynamicsMcpEndpoint(
        " https://Contoso.CRM4.dynamics.com/main.aspx?appid=1&pagetype=dashboard ",
      ),
    ).toEqual({ product: "dataverse", mcpUrl: "https://contoso.crm4.dynamics.com/api/mcp" });
    expect(
      microsoftDynamicsMcpEndpoint("https://contoso.crm.dynamics.com/api/mcp_preview"),
    ).toEqual({ product: "dataverse", mcpUrl: "https://contoso.crm.dynamics.com/api/mcp_preview" });
    expect(microsoftDynamicsMcpEndpoint("https://usmf.operations.dynamics.com/?cmp=USMF")).toEqual({
      product: "finance_operations",
      mcpUrl: "https://usmf.operations.dynamics.com/mcp",
    });
    for (const value of ["", "example.com", "http://contoso.crm.dynamics.com", "ftp://x"])
      expect(microsoftDynamicsMcpEndpoint(value)).toBeNull();
  });

  test("default scope is the environment's own delegated permission", () => {
    expect(microsoftDynamicsDefaultScope("https://contoso.crm17.dynamics.com/api/mcp")).toBe(
      "https://contoso.crm17.dynamics.com/user_impersonation",
    );
    expect(microsoftDynamicsDefaultScope("https://usmf.operations.dynamics.com/mcp")).toBe(
      "https://usmf.operations.dynamics.com/.default",
    );
    expect(microsoftDynamicsDefaultScope("https://example.com/mcp")).toBeNull();
  });

  test("a pasted environment address is stored as its endpoint; other servers are unchanged", () => {
    expect(
      canonicalMcpEndpointUrl("https://contoso.crm4.dynamics.com/main.aspx?appid=1&pagetype=x"),
    ).toBe("https://contoso.crm4.dynamics.com/api/mcp");
    expect(canonicalMcpEndpointUrl("https://contoso.crm4.dynamics.com/api/mcp")).toBe(
      "https://contoso.crm4.dynamics.com/api/mcp",
    );
    expect(canonicalMcpEndpointUrl("https://mcp.example.com/sse?x=1")).toBe(
      "https://mcp.example.com/sse?x=1",
    );
  });

  test("the Web API root belongs to Dataverse endpoints only", () => {
    expect(dataverseWebApiBase("https://contoso.crm17.dynamics.com/api/mcp")).toBe(
      "https://contoso.crm17.dynamics.com/api/data/v9.2/",
    );
    expect(dataverseWebApiBase("https://usmf.operations.dynamics.com/mcp")).toBeNull();
  });

  const BC_TENANT = "017dcee4-abab-4d45-9546-a26f65d15431";
  const BC_ROOT = `https://api.businesscentral.dynamics.com/v2.0/${BC_TENANT}/Production/api/v2.0`;

  test("a Business Central web client or API address becomes its environment's API root", () => {
    expect(
      microsoftDynamicsMcpEndpoint(
        `https://businesscentral.dynamics.com/${BC_TENANT.toUpperCase()}/Production?company=CRONUS%20NO&page=22`,
      ),
    ).toEqual({ product: "business_central", mcpUrl: BC_ROOT });
    expect(
      microsoftDynamicsMcpEndpoint(
        "businesscentral.dynamics.com/contoso.onmicrosoft.com/Sandbox-1",
      ),
    ).toEqual({
      product: "business_central",
      mcpUrl:
        "https://api.businesscentral.dynamics.com/v2.0/contoso.onmicrosoft.com/Sandbox-1/api/v2.0",
    });
    // Without an environment the web client opens the default one, Production.
    expect(
      microsoftDynamicsMcpEndpoint(`https://businesscentral.dynamics.com/${BC_TENANT}?company=X`),
    ).toEqual({ product: "business_central", mcpUrl: BC_ROOT });
    expect(
      microsoftDynamicsMcpEndpoint(`https://businesscentral.dynamics.com/?tenant=${BC_TENANT}`),
    ).toEqual({ product: "business_central", mcpUrl: BC_ROOT });
    expect(microsoftDynamicsMcpEndpoint("https://businesscentral.dynamics.com/Sandbox")).toEqual({
      product: "business_central",
      mcpUrl: "https://api.businesscentral.dynamics.com/v2.0/Sandbox/api/v2.0",
    });
    expect(microsoftDynamicsMcpEndpoint(`${BC_ROOT}/companies?$top=1`)).toEqual({
      product: "business_central",
      mcpUrl: BC_ROOT,
    });
    for (const value of [
      "https://businesscentral.dynamics.com/not an environment",
      "https://businesscentral.dynamics.com/SignIn?ReturnUrl=%2F",
      `https://businesscentral.dynamics.com/${BC_TENANT}/deeplink?company=X`,
      "https://api.businesscentral.dynamics.com/v2.0/Production/api/microsoft/automation/v2.0",
      "https://api.businesscentral.dynamics.com/v1.0/Production/api/v2.0",
      "https://mcp.businesscentral.dynamics.com",
    ])
      expect(microsoftDynamicsMcpEndpoint(value)).toBeNull();
  });

  test("only the canonical Business Central API root is a connection URL", () => {
    expect(microsoftDynamicsProductForMcpUrl(BC_ROOT)).toBe("business_central");
    expect(
      microsoftDynamicsProductForMcpUrl(
        "https://api.businesscentral.dynamics.com/v2.0/Production/api/v2.0",
      ),
    ).toBe("business_central");
    for (const url of [
      `${BC_ROOT}/`,
      `${BC_ROOT}/companies`,
      `${BC_ROOT}?x=1`,
      BC_ROOT.replace(BC_TENANT, BC_TENANT.toUpperCase()),
      `https://businesscentral.dynamics.com/${BC_TENANT}/Production`,
    ])
      expect(microsoftDynamicsProductForMcpUrl(url)).toBeNull();
    expect(businessCentralEnvironment(BC_ROOT)).toEqual({
      tenant: BC_TENANT,
      environment: "Production",
    });
    expect(businessCentralApiBase(BC_ROOT)).toBe(`${BC_ROOT}/`);
    expect(businessCentralApiBase("https://contoso.crm17.dynamics.com/api/mcp")).toBeNull();
    expect(dataverseWebApiBase(BC_ROOT)).toBeNull();
    expect(microsoftDynamicsDefaultScope(BC_ROOT)).toBe(
      "https://api.businesscentral.dynamics.com/Financials.ReadWrite.All",
    );
    expect(
      canonicalMcpEndpointUrl(`https://businesscentral.dynamics.com/${BC_TENANT}/Production`),
    ).toBe(BC_ROOT);
    expect(microsoftDynamicsEnvironmentAddress(BC_ROOT)).toBe(
      `businesscentral.dynamics.com/${BC_TENANT}/Production`,
    );
    expect(microsoftDynamicsEnvironmentAddress("https://contoso.crm17.dynamics.com/api/mcp")).toBe(
      "contoso.crm17.dynamics.com",
    );
    expect(microsoftDynamicsEnvironmentAddress("https://example.com/mcp")).toBeNull();
  });

  test("a Business Central address is never read by dropping part of its path", () => {
    // Production 6.21.0: the tenant segment was taken as the environment and
    // "/Production" was dropped, so every query found no such environment.
    for (const value of [
      "https://businesscentral.dynamics.com/opengenitest2026/Production",
      "https://businesscentral.dynamics.com/opengenitest2026/Production?company=CRONUS",
      "businesscentral.dynamics.com/contoso/Sandbox/",
    ]) {
      expect(microsoftDynamicsMcpEndpoint(value)).toBeNull();
      expect(canonicalMcpEndpointUrl(value)).toBe(value);
      const problem = microsoftDynamicsAddressProblem(value);
      expect(problem).toContain("isn't a tenant ID or domain");
      expect(problem).toContain("address bar");
      expect(problem).toContain(
        "businesscentral.dynamics.com/<tenant>.onmicrosoft.com/<environment>",
      );
    }
    // Anything after the environment other than a web client page is refused too.
    for (const value of [
      `https://businesscentral.dynamics.com/${BC_TENANT}/Production/extra`,
      "https://businesscentral.dynamics.com/contoso.onmicrosoft.com/Production/a/b",
      "https://businesscentral.dynamics.com/Production/extra/deeplink",
    ]) {
      expect(microsoftDynamicsMcpEndpoint(value)).toBeNull();
      expect(microsoftDynamicsAddressProblem(value)).toEqual(expect.any(String));
    }
    expect(
      microsoftDynamicsAddressProblem(
        `https://businesscentral.dynamics.com/${BC_TENANT}/Production/extra`,
      ),
    ).toContain('more after the environment "Production"');
    for (const value of [
      "https://businesscentral.dynamics.com/SignIn?ReturnUrl=%2F",
      `https://businesscentral.dynamics.com/${BC_TENANT}/deeplink?company=X`,
      // A device client page is a page, never a tenant (it looks like a domain).
      "https://businesscentral.dynamics.com/tablet.aspx?company=CRONUS",
      "https://businesscentral.dynamics.com/phone.aspx",
      "https://businesscentral.dynamics.com/not an environment",
    ])
      expect(microsoftDynamicsAddressProblem(value)).toContain("doesn't name an environment");
    expect(
      microsoftDynamicsAddressProblem(
        "https://api.businesscentral.dynamics.com/v2.0/opengenitest2026/Production/api/v2.0",
      ),
    ).toContain("only the standard API");
    expect(
      microsoftDynamicsAddressProblem(
        "https://api.businesscentral.dynamics.com/v2.0/Production/api/microsoft/automation/v2.0",
      ),
    ).toContain("only the standard API");
  });

  test("valid Business Central addresses keep working and have no problem", () => {
    const cases: Array<[string, string]> = [
      [`https://businesscentral.dynamics.com/${BC_TENANT}/Production`, BC_ROOT],
      [
        `https://businesscentral.dynamics.com/${BC_TENANT}/Production/?company=CRONUS&page=22`,
        BC_ROOT,
      ],
      [`https://businesscentral.dynamics.com/${BC_TENANT}/Production/deeplink?company=X`, BC_ROOT],
      [`https://businesscentral.dynamics.com/${BC_TENANT}?company=X`, BC_ROOT],
      [
        "https://businesscentral.dynamics.com/opengenitest2026.onmicrosoft.com/Production",
        "https://api.businesscentral.dynamics.com/v2.0/opengenitest2026.onmicrosoft.com/Production/api/v2.0",
      ],
      [
        "https://businesscentral.dynamics.com/Sandbox?company=CRONUS",
        "https://api.businesscentral.dynamics.com/v2.0/Sandbox/api/v2.0",
      ],
      [
        "https://businesscentral.dynamics.com/Sandbox/deeplink?company=CRONUS",
        "https://api.businesscentral.dynamics.com/v2.0/Sandbox/api/v2.0",
      ],
      [
        "https://businesscentral.dynamics.com/?company=CRONUS",
        "https://api.businesscentral.dynamics.com/v2.0/Production/api/v2.0",
      ],
      [BC_ROOT, BC_ROOT],
      [`https://businesscentral.dynamics.com/${BC_TENANT}/Production/phone.aspx`, BC_ROOT],
    ];
    for (const [value, mcpUrl] of cases) {
      expect(microsoftDynamicsMcpEndpoint(value)).toEqual({ product: "business_central", mcpUrl });
      expect(microsoftDynamicsAddressProblem(value)).toBeNull();
    }
    // Other products and other servers never report a Business Central problem.
    for (const value of [
      "https://contoso.crm4.dynamics.com/main.aspx",
      "https://mcp.example.com/a/b",
      "nope",
    ])
      expect(microsoftDynamicsAddressProblem(value)).toBeNull();
  });
});
