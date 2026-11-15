import { expect, test } from "bun:test";
import type { AgentInputItem } from "@openai/agents";
import { repositorySkillsContextItem } from "@opengeni/contracts";
import { repositorySkillsContextInputFilter } from "../src/repository-skills-context";

const user = (content: string) => ({ type: "message", role: "user", content }) as AgentInputItem;
const item = (index: string) => repositorySkillsContextItem(index) as unknown as AgentInputItem;

function setup(withIndex: (index: string) => Promise<readonly AgentInputItem[] | null>) {
  const history = [user("first"), user("second")];
  const notice = user("turn notice");
  const original = [...history, notice];
  const state = { visible: "Index A" as string | null };
  const filter = repositorySkillsContextInputFilter(state, original, history.length, withIndex)!;
  const call = (input: AgentInputItem[]) =>
    filter({
      modelData: { input, instructions: "system" },
      agent: {} as never,
      context: undefined,
    });
  return { history, notice, original, state, call };
}

test("the run's history is replaced by the history later turns load", async () => {
  let builds = 0;
  const { history, notice, original, call } = setup(async (index) => {
    builds++;
    return [history[0]!, item(index), history[1]!];
  });
  const reply = user("reply");
  const first = await call([...original]);
  const second = await call([...original, reply]);
  expect(first.input).toEqual([history[0], item("Index A"), history[1], notice]);
  expect(second.input).toEqual([history[0], item("Index A"), history[1], notice, reply]);
  // Built once per index, so every request carries the same items.
  expect(builds).toBe(1);
});

test("nothing changes without a new index or once the input was rewritten", async () => {
  const { history, original, state, call } = setup(async (index) => [...history, item(index)]);
  state.visible = null;
  expect((await call([...original])).input).toEqual(original);
  state.visible = "Index A";
  // A retry that loaded the stored item already shows it.
  const loaded = [history[0]!, item("Index A"), ...original.slice(1)];
  expect((await call(loaded)).input).toBe(loaded);
  // Compaction during the run rewrote the prefix.
  const compacted = [user("summary"), ...original.slice(2)];
  expect((await call(compacted)).input).toBe(compacted);
});

test("a failure to build the history fails the request", async () => {
  const { original, call } = setup(async () => {
    throw new Error("attachment read failed");
  });
  await expect(call([...original])).rejects.toThrow("attachment read failed");
});
