import { expect, test } from "bun:test";
import { catalogServiceIdentity, mergeConnectionServices } from "./connection-services";
const option = (id: string, connected = false) => ({
  id,
  name: id,
  status: connected ? "Connected" : "Not connected",
  connected,
  onOpen: () => {},
});
test("groups explicit Slack identity without conflating its accounts", () => {
  const result = mergeConnectionServices([
    { id: "slack", name: "Slack", options: [option("bot", true)] },
    { ...catalogServiceIdentity("mcp:slack", "Slack", "slack.com"), options: [option("mcp")] },
  ]);
  expect(result).toHaveLength(1);
  expect(result[0]!.options.map((x) => [x.id, x.connected])).toEqual([
    ["bot", true],
    ["mcp", false],
  ]);
});
test("same display name is not evidence of shared provider identity", () => {
  expect(
    mergeConnectionServices([
      { ...catalogServiceIdentity("one", "Slack", "other.example"), options: [option("one")] },
      { id: "slack", name: "Slack", options: [option("bot")] },
    ]),
  ).toHaveLength(2);
});
test("repeat options are deduplicated by stable identity", () => {
  expect(
    mergeConnectionServices([
      { id: "x", name: "X", options: [option("a")] },
      { id: "x", name: "X", options: [option("a"), option("b")] },
    ])[0]!.options.map((x) => x.id),
  ).toEqual(["a", "b"]);
});

test("merging preserves host curation order rather than alphabetizing services", () => {
  expect(
    mergeConnectionServices([
      { id: "z", name: "Z", options: [option("z")] },
      { id: "a", name: "A", options: [option("a")] },
    ]).map((service) => service.id),
  ).toEqual(["z", "a"]);
});
