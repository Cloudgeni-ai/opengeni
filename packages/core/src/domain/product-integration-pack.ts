import type { CapabilityPack, CapabilityPackSkill } from "@opengeni/contracts";
import {
  productIntegrationSkillDescription,
  productIntegrationSkillFiles,
} from "./product-integration-skill.gen";

export const OPENGENI_PRODUCT_INTEGRATION_PACK_ID = "opengeni-product-integration";

/** Generated from the canonical external coding-agent guide, with an explicit
 * session-selected wrapper. Installation grants no executable capabilities. */
export const OPENGENI_PRODUCT_INTEGRATION_SKILL = {
  name: OPENGENI_PRODUCT_INTEGRATION_PACK_ID,
  description: productIntegrationSkillDescription,
  activationMode: "session_selected",
  files: productIntegrationSkillFiles,
} satisfies CapabilityPackSkill;

export const OPENGENI_PRODUCT_INTEGRATION_PACK = {
  id: OPENGENI_PRODUCT_INTEGRATION_PACK_ID,
  name: "OpenGeni Product Integration",
  description:
    "Help an implementation agent add OpenGeni to an external product with adaptive discovery, tenant-safe boundaries, framework-native UI, authorized data tools, and the customer's chosen delivery autonomy. Installation stays inactive until one implementation session selects the Skill.",
  role: "software-engineering",
  category: "product-integration",
  version: "0.2.0",
  skills: [OPENGENI_PRODUCT_INTEGRATION_SKILL],
  components: [],
  tools: [],
  connectors: [],
  knowledge: [],
  scheduledTaskTemplates: [],
  automationTemplates: [],
  metadata: {
    audience: "integration-agent",
    purpose: "implementation-guidance",
    implementationOnly: true,
    skillActivation: "session-selected",
    installationExposure: "none",
    grantsExecutableCapabilities: false,
    canonicalSource: ".agents/skills/opengeni-client",
  },
} satisfies CapabilityPack;
