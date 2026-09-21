import { describe, expect, test } from "bun:test";
import {
  OrganizationIntegrationPolicy,
  UpdateOrganizationIntegrationPolicyRequest,
  assertOrganizationIntegrationAllowed,
} from "../src/organization-integration-policy";

describe("organization integration acquisition policy", () => {
  test("default is unrestricted revision zero", () => {
    const policy = OrganizationIntegrationPolicy.parse({});
    expect(policy).toEqual({ mode: "unrestricted", allowedIntegrationKeys: [], revision: 0 });
    expect(() => assertOrganizationIntegrationAllowed(policy, null)).not.toThrow();
  });
  test("empty restriction and unknown classifications deny", () => {
    const policy = OrganizationIntegrationPolicy.parse({ mode: "restricted" });
    expect(() => assertOrganizationIntegrationAllowed(policy, "sample")).toThrow();
    expect(() => assertOrganizationIntegrationAllowed(policy, null)).toThrow();
  });
  test("only exact curated identities and explicit custom categories match", () => {
    const policy = OrganizationIntegrationPolicy.parse({
      mode: "restricted",
      allowedIntegrationKeys: ["sample", "custom-mcp"],
    });
    for (const key of ["sample", "custom-mcp"])
      expect(() => assertOrganizationIntegrationAllowed(policy, key)).not.toThrow();
    for (const key of [null, "sample.example", "custom-openapi", "custom-graphql"])
      expect(() => assertOrganizationIntegrationAllowed(policy, key)).toThrow();
  });
  test("updates require UUID and safe revision; malformed identities rejected", () => {
    const request = {
      mode: "restricted",
      allowedIntegrationKeys: [],
      expectedRevision: 0,
      operationId: crypto.randomUUID(),
    };
    expect(UpdateOrganizationIntegrationPolicyRequest.safeParse(request).success).toBe(true);
    for (const patch of [
      { operationId: "bad" },
      { expectedRevision: -1 },
      { expectedRevision: 1.5 },
      { allowedIntegrationKeys: [""] },
      { allowedIntegrationKeys: ["https://sample.example"] },
      { allowedIntegrationKeys: ["sample", "sample"] },
    ]) {
      expect(
        UpdateOrganizationIntegrationPolicyRequest.safeParse({ ...request, ...patch }).success,
      ).toBe(false);
    }
  });
});
