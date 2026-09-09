type Item = Record<string, unknown>;

/** Synthetic protocol history shared by regression coverage and the live canary. */
export function compactionHistoryFixture(toolReceipt = "synthetic-tool-receipt"): Item[] {
  const items: Item[] = [
    {
      type: "message",
      role: "user",
      content: "Fixture release is blue. Keep the verified tool facts and continue checking it.",
    },
  ];
  for (let index = 0; index < 50; index += 1) {
    const suffix = index === 0 ? "fixture" : String(index);
    items.push(
      {
        type: "reasoning",
        id: `rs_${suffix}`,
        content: [],
        providerData: {
          id: `rs_${suffix}`,
          type: "reasoning",
          encrypted_content: "opaque-fixture",
        },
      },
      {
        type: "message",
        id: `msg_${suffix}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: `Inspecting fixture ${index}.` }],
        providerData: { id: `msg_${suffix}` },
      },
      {
        type: "function_call",
        id: `fc_${suffix}`,
        callId: `call_${index}`,
        name: "inspect",
        arguments: JSON.stringify({ id: `resource_${index}`, token: "literal-fixture-content" }),
        status: "completed",
        providerData: { id: `fc_${suffix}` },
      },
      {
        type: "function_call_result",
        callId: `call_${index}`,
        name: "inspect",
        status: "completed",
        output: "Synthetic inspection detail. ".repeat(950),
      },
    );
  }
  items.push(
    {
      type: "tool_search_call",
      id: "tsc_fixture",
      arguments: { query: "inspect" },
      providerData: { call_id: "search_fixture", execution: "client" },
    },
    {
      type: "tool_search_output",
      tools: [],
      providerData: { call_id: "search_fixture", execution: "client" },
    },
    {
      type: "apply_patch_call",
      id: "apc_fixture",
      callId: "patch_fixture",
      operation: { type: "update_file", path: "/tmp/fixture.txt", diff: "@@\n-red\n+blue" },
    },
    {
      type: "apply_patch_call_output",
      callId: "patch_fixture",
      status: "completed",
      output: `Patched fixture. Verification receipt: ${toolReceipt}`,
    },
  );
  return items;
}
