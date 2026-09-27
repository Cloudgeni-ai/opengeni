import { expect, test } from "bun:test";
import {
  CreateSessionRequest,
  ScheduledTaskAgentConfig,
  AutomationSessionTemplate,
  BundledSkillSelection,
  resolveBundledSkillSelection,
  withBundledSkillSelectionMetadata,
  bundledSkillSelectionFromMetadata,
  storedBundledSkillSelectionIdentity,
} from "../src";

const documents = "builtin:opengeni-documents" as const;
const sites = "builtin:opengeni-sites" as const;
const projects = "builtin:opengeni-projects" as const;

for (const help of ["builtin:opengeni-help", "builtin:opengeni-client"] as const)
  test(`${help} is addressable and cannot escape a host's empty selection`, () => {
    expect(
      CreateSessionRequest.parse({ initialMessage: "Help", bundledSkillIds: [help] })
        .bundledSkillIds,
    ).toEqual([help]);
    expect(
      ScheduledTaskAgentConfig.parse({ prompt: "Help", bundledSkillIds: [help] }).bundledSkillIds,
    ).toEqual([help]);
    expect(
      AutomationSessionTemplate.parse({ prompt: "Help", bundledSkillIds: [help] }).bundledSkillIds,
    ).toEqual([help]);
    expect(resolveBundledSkillSelection(undefined, [])).toEqual([]);
    expect(() => resolveBundledSkillSelection([help], [])).toThrow("cannot widen");
  });

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

test("stored selection drops ids this build does not know, while input stays strict", () => {
  const key = "_opengeni_bundled_skill_ids_v1";
  const unknown = "builtin:not-in-this-build";
  expect(bundledSkillSelectionFromMetadata({ [key]: [unknown, sites, documents] })).toEqual([
    documents,
    sites,
  ]);
  // Dropping can only narrow: a stored list of unknown ids reads as an explicit none.
  expect(bundledSkillSelectionFromMetadata({ [key]: [unknown] })).toEqual([]);
  expect(bundledSkillSelectionFromMetadata({})).toBeUndefined();
  expect(() => bundledSkillSelectionFromMetadata({ [key]: "not a list" })).toThrow();
  // Only unknown id strings are tolerated; a non-string entry is not an id.
  expect(() => bundledSkillSelectionFromMetadata({ [key]: [sites, null] })).toThrow();
  // Replay identity keeps the exact stored value, including unknown ids.
  expect(storedBundledSkillSelectionIdentity({ [key]: [unknown, sites] })).toEqual([
    unknown,
    sites,
  ]);
  expect(storedBundledSkillSelectionIdentity({})).toBeUndefined();
  expect(BundledSkillSelection.safeParse([documents, unknown]).success).toBe(false);
  expect(() => withBundledSkillSelectionMetadata({}, [unknown as typeof documents])).toThrow();
  expect(
    CreateSessionRequest.safeParse({ initialMessage: "Run", bundledSkillIds: [unknown] }).success,
  ).toBe(false);
});
