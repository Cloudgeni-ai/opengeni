import { afterEach, expect, test } from "bun:test";
import type {
  HumanInputQuestion,
  SkillRecord,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import { act, createElement } from "react";
import { HumanInputForm } from "../src/components/human-input-form";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";
registerDom();
let mounted: RenderedComponent | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});
const reference = {
  sourceOperationId: "operation",
  skillId: "skill",
  revisionId: "revision",
  expectedRevisionId: null,
  expectedScopeVersion: 1,
};
const question: HumanInputQuestion = {
  id: "skill:revision",
  kind: "single_select",
  label: "Save this Skill?",
  prompt: "Save this exact revision?",
  options: [
    { id: "save", label: "Save" },
    { id: "skip", label: "Don't save" },
  ],
  required: true,
  allowOther: false,
  skillReview: reference,
};
const request = { id: "request", questions: [question], allowSkip: false, expiresAt: null };
const skill: SkillRecord = {
  id: "skill",
  stableKey: "test",
  scope: "workspace",
  scopeVersion: 1,
  status: "proposed",
  activeRevisionId: null,
  revisionId: "revision",
  title: "Test Skill",
  description: null,
  contentHash: "hash",
  source: null,
  activationMode: "workspace_managed",
  pendingRevisionIds: ["revision"],
  files: [
    { path: "SKILL.md", content: "# Skill\n" + "Full content. ".repeat(600) + "END_OF_SKILL" },
    { path: "scripts/helper.txt", content: "<script>window.bad=true</script>" },
  ],
};
async function chooseAndSubmit(value: string) {
  await act(async () => {
    const input =
      mounted!.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[
        value === "save" ? 0 : 1
      ]!;
    input.click();
  });
  await act(async () =>
    mounted!.container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
test("shows every full immutable file and submits one Save with no second approval UI", async () => {
  const responses: SubmitHumanInputResponseRequest[] = [];
  const reads: unknown[] = [];
  mounted = await renderComponent(
    createElement(HumanInputForm, {
      request,
      loadSkillReview: async (ref) => {
        reads.push(ref);
        return skill;
      },
      onSubmit: (response) => {
        responses.push(response);
      },
    }),
  );
  expect(reads).toEqual([reference]);
  expect(mounted.container.querySelectorAll('input[type="radio"]').length).toBe(2);
  expect(mounted.container.querySelector('input[type="text"]')).toBeNull();
  const files = mounted.container.querySelectorAll("pre");
  expect(files.length).toBe(2);
  expect(files[0]!.textContent).toBe(skill.files[0]!.content);
  expect(files[1]!.textContent).toBe(skill.files[1]!.content);
  expect(mounted.container.querySelector("script")).toBeNull();
  await chooseAndSubmit("save");
  expect(responses).toEqual([
    { outcome: "answered", answers: [{ questionId: question.id, values: ["save"] }] },
  ]);
});
test("cannot save without a preview-capable client, but can decline", async () => {
  const responses: SubmitHumanInputResponseRequest[] = [];
  mounted = await renderComponent(
    createElement(HumanInputForm, {
      request,
      onSubmit: (response) => {
        responses.push(response);
      },
    }),
  );
  expect(mounted.container.textContent).toContain("This client cannot preview Skill files");
  await chooseAndSubmit("save");
  expect(responses).toEqual([]);
  await chooseAndSubmit("skip");
  expect(responses.length).toBe(1);
});
test("wrong revision is refused and a retried exact preview enables Save", async () => {
  let reads = 0;
  const responses: SubmitHumanInputResponseRequest[] = [];
  mounted = await renderComponent(
    createElement(HumanInputForm, {
      request,
      loadSkillReview: async () => (++reads === 1 ? { ...skill, revisionId: "other" } : skill),
      onSubmit: (response) => {
        responses.push(response);
      },
    }),
  );
  await chooseAndSubmit("save");
  expect(responses).toEqual([]);
  expect(mounted.container.textContent).toContain("could not be verified");
  await act(async () => {
    [...mounted!.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Retry preview")!
      .click();
  });
  await chooseAndSubmit("save");
  expect(responses.length).toBe(1);
});
test("late preview from the previous account cannot authorize Save for a new loader", async () => {
  let settle!: (skill: SkillRecord) => void;
  const responses: SubmitHumanInputResponseRequest[] = [];
  const onSubmit = (response: SubmitHumanInputResponseRequest) => {
    responses.push(response);
  };
  mounted = await renderComponent(
    createElement(HumanInputForm, {
      request,
      loadSkillReview: () =>
        new Promise<SkillRecord>((resolve) => {
          settle = resolve;
        }),
      onSubmit,
    }),
  );
  await mounted.rerender(
    createElement(HumanInputForm, {
      request,
      loadSkillReview: async () => {
        throw new Error("Access revoked");
      },
      onSubmit,
    }),
  );
  await act(async () => settle(skill));
  expect(mounted.container.querySelector("pre")).toBeNull();
  expect(mounted.container.textContent).toContain("Access revoked");
  await chooseAndSubmit("save");
  expect(responses).toEqual([]);
});

test("identical refreshed questions retain the preview and an in-flight exact read", async () => {
  let settle!: (skill: SkillRecord) => void;
  let reads = 0;
  const responses: SubmitHumanInputResponseRequest[] = [];
  const loader = () => {
    reads++;
    return new Promise<SkillRecord>((resolve) => {
      settle = resolve;
    });
  };
  const onSubmit = (response: SubmitHumanInputResponseRequest) => {
    responses.push(response);
  };
  mounted = await renderComponent(
    createElement(HumanInputForm, { request, loadSkillReview: loader, onSubmit }),
  );
  const refreshed = () => ({
    ...request,
    questions: request.questions.map((item) => ({
      ...item,
      skillReview: { ...item.skillReview! },
      options: item.options.map((option) => ({ ...option })),
    })),
  });
  await mounted.rerender(
    createElement(HumanInputForm, { request: refreshed(), loadSkillReview: loader, onSubmit }),
  );
  expect(reads).toBe(1);
  await act(async () => settle(skill));
  await mounted.rerender(
    createElement(HumanInputForm, { request: refreshed(), loadSkillReview: loader, onSubmit }),
  );
  expect(reads).toBe(1);
  expect(mounted.container.querySelector("pre")?.textContent).toBe(skill.files[0]!.content);
  await chooseAndSubmit("save");
  expect(responses.length).toBe(1);
});
