import { describe, expect, test } from "bun:test";
import {
  canonicalMcpEndpointUrl,
  dataverseWebApiBase,
  microsoftDynamicsDefaultScope,
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
});
