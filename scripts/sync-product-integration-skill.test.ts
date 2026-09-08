import { expect, test } from "bun:test";
import {
  checkProductIntegrationSkill,
  productIntegrationSkillSource,
} from "./sync-product-integration-skill";

test("the published implementation Pack exactly matches the canonical guide and explicit wrapper", async () => {
  await checkProductIntegrationSkill();
  expect(await productIntegrationSkillSource()).toBe(await productIntegrationSkillSource());
});
