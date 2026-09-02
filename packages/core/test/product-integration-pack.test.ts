import { describe, expect, test } from "bun:test";
import { CapabilityPack } from "@opengeni/contracts";
import { buildPortableSkillArtifact } from "@opengeni/runtime/skill-library";

import {
  OPENGENI_PRODUCT_INTEGRATION_PACK,
  OPENGENI_PRODUCT_INTEGRATION_PACK_ID,
} from "../src/domain/product-integration-pack";
import {
  capabilityPackRequiresInstallationPlan,
  getCapabilityPack,
  inlinePackSkillInstall,
} from "../src/domain/packs";

describe("OpenGeni Product Integration Pack", () => {
  test("is a built-in implementation Pack with honest workspace-wide Skill scope", () => {
    const pack = getCapabilityPack(OPENGENI_PRODUCT_INTEGRATION_PACK_ID);

    expect(pack).toBe(OPENGENI_PRODUCT_INTEGRATION_PACK);
    expect(CapabilityPack.parse(pack)).toEqual(pack);
    expect(pack).toMatchObject({
      name: "OpenGeni Product Integration",
      category: "product-integration",
      metadata: {
        audience: "integration-agent",
        purpose: "implementation-guidance",
        skillExposure: "all-sessions-in-installation-workspace",
        separationModel: "dedicated-implementation-workspace",
        grantsExecutableCapabilities: false,
      },
    });
    expect(pack?.skills.map((skill) => skill.name)).toEqual(["opengeni-product-integration"]);
    expect(pack?.tools).toEqual([]);
    expect(pack?.connectors).toEqual([]);
    expect(pack?.knowledge).toEqual([]);
    expect(pack?.automationTemplates).toEqual([]);
    expect(pack?.scheduledTaskTemplates).toEqual([]);
    expect(pack?.rig).toBeUndefined();
    expect(pack?.variableSet).toBeUndefined();
    expect(pack?.sandboxImage).toBeUndefined();
    expect(pack?.sandboxProviderImages).toBeUndefined();
    expect(capabilityPackRequiresInstallationPlan(pack!)).toBe(true);
    expect(pack?.description).toContain("dedicated implementation workspace");
    expect(pack?.skills[0]?.description).toContain("available to every session");
  });

  test("materializes one valid immutable Skill with complete progressive-disclosure references", () => {
    const pack = OPENGENI_PRODUCT_INTEGRATION_PACK;
    const skill = pack.skills[0]!;
    const artifact = buildPortableSkillArtifact(skill.files);
    const install = inlinePackSkillInstall(pack, skill);

    expect(artifact.name).toBe(skill.name);
    expect(artifact.description).toBe(skill.description);
    expect(artifact.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/data-tools-and-credentials.md",
      "references/discovery-and-autonomy.md",
      "references/isolation-and-authorization.md",
      "references/product-shapes-and-ui.md",
      "references/runtime-profile-and-verification.md",
    ]);
    expect(install.contentSha256).toBe(artifact.contentSha256);
    expect(install.files.map((file) => file.path)).toEqual(artifact.files.map((file) => file.path));

    const entrypoint = skill.files.find((file) => file.path === "SKILL.md")!.content;
    const linkedReferences = [...entrypoint.matchAll(/\]\((references\/[^)]+\.md)\)/g)]
      .map((match) => match[1]!)
      .sort();
    const suppliedReferences = skill.files
      .map((file) => file.path)
      .filter((path) => path.startsWith("references/"))
      .sort();
    expect(linkedReferences).toEqual(suppliedReferences);
  });

  test("retains the decisions that prevent the observed integration failures", () => {
    const files = new Map(
      OPENGENI_PRODUCT_INTEGRATION_PACK.skills[0]!.files.map((file) => [file.path, file.content]),
    );
    const entrypoint = files.get("SKILL.md")!;
    const isolation = files.get("references/isolation-and-authorization.md")!;
    const data = files.get("references/data-tools-and-credentials.md")!;
    const runtime = files.get("references/runtime-profile-and-verification.md")!;
    const autonomy = files.get("references/discovery-and-autonomy.md")!;

    expect(entrypoint).toContain("Turning workspace Memory off does not isolate conversations");
    expect(entrypoint).toContain("defense in depth, not a hard tenant boundary");
    expect(isolation).toContain("One workspace per end user");
    expect(isolation).toContain("One workspace per chat");
    expect(isolation).toContain("Omitting firstPartyMcpTools");
    expect(data).toContain("does not accept arbitrary JavaScript, Python, Go, or C# callback");
    expect(data).toContain("OpenAPI 3.0 or 3.1");
    expect(data).toContain("distinct control-plane resources");
    expect(data).toContain("credential brokerage, not zero-knowledge storage");
    expect(runtime).toContain("installed Skill is workspace-wide");
    expect(runtime).toContain("dedicated implementation workspace");
    expect(runtime).toContain("not retransmitted on every turn");
    expect(runtime).toContain("same account balance");
    expect(autonomy).toContain("technical capability, not permission");
  });
});
