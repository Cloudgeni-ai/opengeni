import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Execute the actual production stage with controlled I/O, rather than a
// second implementation of its concurrency and error ordering.
const source = readFileSync(
  new URL("../src/activities/agent-turn/run.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf("const [learningResult, attachmentResult] =");
const end = source.indexOf("if (!attachmentAuthority)", start);
if (start < 0 || end < 0) throw new Error("Missing independent startup reads");
const stage = new Function(
  "ports",
  `
  const { freezeAgentLearningPolicy, getSessionAuthorityProjection } = ports;
  const observability = {}, db = {}, input = {}, learningActor = {}, turnExecutionPolicy = {}, turn = {};
  const measureTurnStartupPhase = (_observability, _phase, run) => run();
  return (async () => { ${source.slice(start, end)} return { learning, attachmentAuthority }; })();
`,
) as (ports: {
  freezeAgentLearningPolicy: () => Promise<unknown>;
  getSessionAuthorityProjection: () => Promise<unknown>;
}) => Promise<unknown>;
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("authority failure waits for the parallel policy write to settle", async () => {
  let finish!: (value: unknown) => void;
  let settled = false;
  const error = new Error("authority failed");
  const result = stage({
    freezeAgentLearningPolicy: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    getSessionAuthorityProjection: async () => {
      throw error;
    },
  }).catch((reason) => {
    settled = true;
    return reason;
  });
  await flush();
  expect(settled).toBe(false);
  finish({ subjectId: "owner" });
  expect(await result).toBe(error);
});

test("the old policy-error precedence and successful values are preserved", async () => {
  const policyError = new Error("policy failed");
  await expect(
    stage({
      freezeAgentLearningPolicy: async () => {
        throw policyError;
      },
      getSessionAuthorityProjection: async () => {
        throw new Error("authority failed");
      },
    }),
  ).rejects.toBe(policyError);
  const learning = { subjectId: "owner" };
  const attachmentAuthority = { authorityEpoch: 3 };
  expect(
    await stage({
      freezeAgentLearningPolicy: async () => learning,
      getSessionAuthorityProjection: async () => attachmentAuthority,
    }),
  ).toEqual({ learning, attachmentAuthority });
});
