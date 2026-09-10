import { expect, test } from "bun:test";
import {
  CreateSessionRequest,
  ScheduledTaskAgentConfig,
  AutomationSessionTemplate,
  BundledSkillSelection,
  resolveBundledSkillSelection,
  withBundledSkillSelectionMetadata,
  bundledSkillSelectionFromMetadata,
} from "../src";

const documents = "builtin:opengeni-documents" as const;
const sites = "builtin:opengeni-sites" as const;
const projects = "builtin:opengeni-projects" as const;

test("Projects uses the ordinary bundle selection and inheritance contract", () => {
  expect(
    CreateSessionRequest.parse({ initialMessage: "Organize", bundledSkillIds: [projects] })
      .bundledSkillIds,
  ).toEqual([projects]);
  expect(
    ScheduledTaskAgentConfig.parse({ prompt: "Organize", bundledSkillIds: [projects] })
      .bundledSkillIds,
  ).toEqual([projects]);
  expect(
    AutomationSessionTemplate.parse({ prompt: "Organize", bundledSkillIds: [projects] })
      .bundledSkillIds,
  ).toEqual([projects]);
  expect(resolveBundledSkillSelection(undefined, [projects])).toEqual([projects]);
  expect(resolveBundledSkillSelection([], [projects])).toEqual([]);
  expect(() => resolveBundledSkillSelection([projects], [])).toThrow("cannot widen");
});

test("bundle selection preserves omitted versus empty across public creation contracts", () => {
  expect(CreateSessionRequest.parse({ initialMessage: "Run" }).bundledSkillIds).toBeUndefined();
  expect(
    CreateSessionRequest.parse({ initialMessage: "Run", bundledSkillIds: [] }).bundledSkillIds,
  ).toEqual([]);
  expect(
    ScheduledTaskAgentConfig.parse({ prompt: "Run", bundledSkillIds: [] }).bundledSkillIds,
  ).toEqual([]);
  expect(
    AutomationSessionTemplate.parse({ prompt: "Run", bundledSkillIds: [documents] })
      .bundledSkillIds,
  ).toEqual([documents]);
  expect(BundledSkillSelection.safeParse(["builtin:unknown"]).success).toBe(false);
  expect(BundledSkillSelection.safeParse([documents, documents]).success).toBe(false);
});

test("children inherit or narrow bundle selection but cannot widen it", () => {
  expect(resolveBundledSkillSelection(undefined, undefined)).toBeUndefined();
  expect(resolveBundledSkillSelection(undefined, [])).toEqual([]);
  expect(resolveBundledSkillSelection(undefined, [documents])).toEqual([documents]);
  expect(resolveBundledSkillSelection([], [documents])).toEqual([]);
  expect(resolveBundledSkillSelection([documents], [sites, documents])).toEqual([documents]);
  expect(() => resolveBundledSkillSelection([sites], [documents])).toThrow("cannot widen");
});

test("bundle selection remains independent of session access and sandbox grouping", () => {
  const groupId = "00000000-0000-4000-8000-000000000001";
  const request = CreateSessionRequest.parse({
    initialMessage: "Run with scoped access",
    bundledSkillIds: [],
    agentAccess: "user",
    memoryScope: "off",
    sandbox: { groupId },
  });
  expect(request.bundledSkillIds).toEqual([]);
  expect(request.agentAccess).toBe("user");
  expect(request.endUser).toBeUndefined();
  expect(request.memoryScope).toBe("off");
  expect(request.sandbox).toEqual({ groupId });
});

test("arbitrary metadata cannot override typed selection at admission", () => {
  const metadata = withBundledSkillSelectionMetadata({ label: "Keep" }, [sites]);
  const original = JSON.stringify(metadata);
  expect(
    bundledSkillSelectionFromMetadata(withBundledSkillSelectionMetadata(metadata, undefined)),
  ).toBeUndefined();
  expect(
    bundledSkillSelectionFromMetadata(withBundledSkillSelectionMetadata(metadata, [])),
  ).toEqual([]);
  expect(
    bundledSkillSelectionFromMetadata(withBundledSkillSelectionMetadata(metadata, [documents])),
  ).toEqual([documents]);
  expect(JSON.stringify(metadata)).toBe(original);
});
