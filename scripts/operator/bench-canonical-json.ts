import { createHash } from "node:crypto";
import { digestCanonicalJson } from "../../packages/tool-gateway/src/catalog";

// Previous implementation, retained only as a paired benchmark control.
function previous(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(previous);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, previous(entry)]),
    );
  }
  return value;
}
const baseline = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(previous(value)), "utf8")
    .digest("hex");
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1]!;
for (const count of [1, 100, 1000]) {
  const input = {
    version: 1,
    entries: Array.from({ length: count }, (_, index) => ({
      identity: { serverId: "sample", toolName: `tool_${index}` },
      modelName: `sample__tool_${index}`,
      description: "A representative authored tool schema.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          Array.from({ length: 12 }, (_fieldValue, field) => [
            `field_${field}`,
            { type: "string", description: "Describe this field.", maxLength: 1000 },
          ]),
        ),
        required: ["field_0"],
      },
      codemodePath: ["sample", `tool_${index}`],
    })),
  };
  const times = { base: [] as number[], candidate: [] as number[] };
  const cpu = { base: [] as number[], candidate: [] as number[] };
  for (let pair = -10; pair < 60; pair++) {
    const results: string[] = [];
    for (const side of pair % 2
      ? (["base", "candidate"] as const)
      : (["candidate", "base"] as const)) {
      const startCpu = process.cpuUsage();
      const start = performance.now();
      results.push((side === "base" ? baseline : digestCanonicalJson)(input));
      const ms = performance.now() - start;
      const used = process.cpuUsage(startCpu);
      if (pair >= 0) {
        times[side].push(ms);
        cpu[side].push((used.user + used.system) / 1000);
      }
    }
    if (results[0] !== results[1]) throw new Error("Digest mismatch");
  }
  console.log(
    JSON.stringify({
      count,
      bytes: Buffer.byteLength(JSON.stringify(input)),
      elapsedMs: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, median(v)])),
      cpuMs: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, median(v)])),
      pairs: 60,
    }),
  );
}
