import { describe, expect, test } from "bun:test";
import { SessionEvent, stableJson } from "../src";

function exactContentCorpus(): string[] {
  const tokenLike = ["gh", "p_", "A".repeat(24)].join("");
  const bearerHeader = ["Author", "ization: ", "Bear", "er ", tokenLike].join("");
  const pemLike = [
    "-----BEGIN ",
    "PRIVATE ",
    "KEY-----\n",
    "c3ludGhldGljLW5vdC1hLXJlYWwta2V5\n",
    "-----END ",
    "PRIVATE ",
    "KEY-----",
  ].join("");
  const urlLike = [
    "https://",
    "synthetic-user",
    ":",
    "synthetic-pass",
    "@example.test/path?",
    "signature",
    "=synthetic-signed-value#fragment",
  ].join("");
  return [
    tokenLike,
    bearerHeader,
    `TOKEN=${tokenLike}`,
    urlLike,
    pemLike,
    `const source = ${JSON.stringify(bearerHeader)};`,
    " leading\tand  repeated whitespace \n",
    "Unicode: café 👩🏽‍💻 e\u0301",
  ];
}

describe("exact internal content contracts", () => {
  test("SessionEvent preserves arbitrary payload strings byte-for-byte", () => {
    const corpus = exactContentCorpus();
    const keyedValues = Object.fromEntries([
      [["se", "cret"].join(""), corpus[1]],
      [["author", "ization"].join(""), corpus[1]],
    ]);
    const payload = {
      corpus,
      nested: {
        value: corpus[0],
        keyedValues,
      },
    };
    const parsed = SessionEvent.parse({
      id: "00000000-0000-4000-8000-000000000020",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      sequence: 42,
      type: "agent.toolCall.output",
      payload,
      occurredAt: "2026-08-05T00:00:00.000Z",
    });

    expect(stableJson(parsed.payload)).toBe(stableJson(payload));
    expect(parsed.payload).toEqual(payload);
  });

  test("SessionEvent preserves executable command and source-edit arguments exactly", () => {
    const exactCommand = [
      "python3 - <<'PY'",
      "from datetime import datetime, timezone",
      "from pathlib import Path",
      'stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")',
      'path = Path("synthetic.ts")',
      "source = path.read_text()",
      'needle = "const cookie ="',
      'replacement = \'const cookie = ["synthetic", "cookie", "value"].join("-");\'',
      "assert needle in source",
      "path.write_text(source.replace(needle, replacement, 1))",
      "print(stamp)",
      "PY",
    ].join("\n");
    const exactArguments = JSON.stringify({
      cmd: exactCommand,
      workdir: "/workspace/synthetic",
    });
    const payload = {
      id: "call_synthetic_exact_content",
      name: "exec_command",
      arguments: exactArguments,
      raw: {
        id: "fc_synthetic_exact_content",
        type: "function_call",
        name: "exec_command",
        callId: "call_synthetic_exact_content",
        status: "completed",
        arguments: exactArguments,
      },
    };
    const parsed = SessionEvent.parse({
      id: "00000000-0000-4000-8000-000000000021",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      sequence: 43,
      type: "agent.toolCall.created",
      payload,
      occurredAt: "2026-08-05T00:00:01.000Z",
    });

    expect(stableJson(parsed.payload)).toBe(stableJson(payload));
    expect(parsed.payload).toEqual(payload);
    expect((parsed.payload as typeof payload).arguments).toBe(exactArguments);
    expect((parsed.payload as typeof payload).raw.arguments).toBe(exactArguments);
    expect(JSON.parse((parsed.payload as typeof payload).arguments).cmd).toBe(exactCommand);
    expect(exactCommand).not.toContain("[redacted]");
  });
});
