import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fleetSource = readFileSync(resolve(here, "..", "src", "sandbox", "fleet.ts"), "utf8");

describe("Connected Machine provisioning builder discipline", () => {
  test("fleet delegates copy-only instructions to the dependency-free builder", () => {
    expect(fleetSource).toContain('} from "./selfhosted-provisioning";');
    expect(fleetSource).toContain(
      'export { buildSelfhostedProvisioningInstructions } from "./selfhosted-provisioning";',
    );
    expect(fleetSource).toContain("| SelfhostedProvisioningInstructions");
    expect(fleetSource).toContain("return buildSelfhostedProvisioningInstructions({");
    expect(fleetSource).toContain("publicBaseUrl: services.settings.publicBaseUrl");
    expect(fleetSource).toContain("workspaceId: ctx.workspaceId");
    expect(fleetSource).not.toContain("function shellSingleQuote");
    expect(fleetSource).not.toContain("function powerShellSingleQuote");
  });
});
