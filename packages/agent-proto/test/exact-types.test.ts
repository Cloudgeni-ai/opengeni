import { expect, test } from "bun:test";

import { ControlRequest, ExecRequest, Hello, type DeepPartial, type Exact } from "../src/index";

// These calls are checked by both the CLI checker and the declaration compiler.
// Variables (rather than only fresh literals) exercise ts-proto's Exact helper.
function checkExactTypes() {
  const extra = { agentId: "agent", unknownField: true };
  // @ts-expect-error unknown top-level fields must not be silently discarded
  Hello.create(extra);
  // @ts-expect-error fromPartial has the same exact-field contract as create
  Hello.fromPartial(extra);

  const nested = { capabilities: { exec: true, unknownField: true } };
  // @ts-expect-error unknown nested fields must also be rejected through variables
  Hello.create(nested);
  // @ts-expect-error nested exactness applies to fromPartial too
  Hello.fromPartial(nested);

  // @ts-expect-error scalar types remain checked
  Hello.create({ agentId: 123 });
  // @ts-expect-error array element types remain checked
  ExecRequest.fromPartial({ command: [123] });
  // @ts-expect-error map values remain checked
  ExecRequest.create({ env: { PATH: 123 } });
  // @ts-expect-error the oneof discriminant must match its payload
  ControlRequest.create({ op: { $case: "hello", ping: {} } });
  const extraUnion = { op: { $case: "hello" as const, hello: { unknownField: true } } };
  // @ts-expect-error nested oneof payloads retain exactness
  ControlRequest.fromPartial(extraUnion);
  const extraValidUnion = {
    op: { $case: "hello" as const, hello: { agentId: "agent", unknownField: true } },
  };
  // @ts-expect-error reject extras even when the payload has known fields too
  ControlRequest.create(extraValidUnion);
  // @ts-expect-error empty protobuf messages are exact too
  ControlRequest.create({ op: { $case: "metrics", metrics: { unknownField: true } } });

  Hello.create({ capabilities: undefined });
  Hello.fromPartial({ capabilities: { exec: true } });
  ExecRequest.create({ command: ["echo", "ok"], env: { LANG: "C" } });
  ControlRequest.fromPartial({ op: { $case: "hello", hello: { agentId: "agent" } } });

  type Choice = { kind: "first"; first?: string } | { kind: "second"; second?: number };
  const choice: Choice = { kind: "second", second: 1 };
  const exact: Exact<Choice, Choice> = choice;
  const partial: DeepPartial<Hello> = { capabilities: undefined };
  Hello.fromPartial(partial);
  const partialRequest: DeepPartial<ControlRequest> = {
    op: { $case: "hello", hello: { agentId: "agent" } },
  };
  ControlRequest.fromPartial(partialRequest);
  return exact;
}

test("partial constructors retain defaults and oneof payloads", () => {
  const hello = Hello.create({ agentId: "agent", capabilities: { exec: true } });
  expect(hello.agentId).toBe("agent");
  expect(hello.capabilities?.exec).toBe(true);
  expect(hello.capabilities?.filesystem).toBe(false);
  expect(Hello.fromPartial({ capabilities: undefined }).capabilities).toBeUndefined();
  const request = ControlRequest.create({ op: { $case: "hello", hello: { agentId: "agent" } } });
  expect(request.op?.$case).toBe("hello");
  expect(ControlRequest.decode(ControlRequest.encode(request).finish())).toEqual(request);
  expect(typeof checkExactTypes).toBe("function");
});
