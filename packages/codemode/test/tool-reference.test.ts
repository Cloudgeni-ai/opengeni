import { expect, test } from "bun:test";
import type { AttemptToolCatalogEntry } from "@opengeni/contracts";
import { catalogToolResolutionMessage, resolveCatalogTool } from "../src/index";

function entry(
  serverId: string,
  toolName: string,
  codemodePath: [string, string],
  modelName: string,
): AttemptToolCatalogEntry {
  return {
    identity: { serverId, toolName },
    modelName,
    codemodePath,
    inputSchema: { type: "object", properties: {} },
    source: "mcp",
    approval: "none",
  };
}

const account = `account-${"c".repeat(64)}`;
const catalog = {
  entries: [
    entry(
      account,
      "orders.get-line-item",
      ["orders_cccccc", "orders_get_line_item"],
      "orders_cccccc__orders_get_line_item",
    ),
    entry(
      account,
      "orders_swap_item",
      ["orders_cccccc", "orders_swap_item"],
      "orders_cccccc__orders_swap_item",
    ),
    entry("mail", "send_message", ["mail", "send_message"], "mail__send_message"),
    entry("chat", "send_message", ["chat", "send_message"], "chat__send_message"),
  ],
};
const path = (reference: string, allowPlainName?: boolean) => {
  const resolution = resolveCatalogTool(
    catalog,
    reference,
    allowPlainName === undefined ? {} : { allowPlainName },
  );
  return "entry" in resolution ? resolution.entry.codemodePath.join(".") : resolution;
};

test("a Codemode tool resolves by its path, model name, server and tool, or own name", () => {
  for (const reference of [
    "orders_cccccc.orders_swap_item",
    "orders_cccccc__orders_swap_item",
    "orders_swap_item",
    `${account}.orders_swap_item`,
  ]) {
    expect(path(reference)).toBe("orders_cccccc.orders_swap_item");
  }
  // The published name, with its own punctuation, under the namespace or alone.
  expect(path("orders_cccccc.orders.get-line-item")).toBe("orders_cccccc.orders_get_line_item");
  expect(path("orders.get-line-item")).toBe("orders_cccccc.orders_get_line_item");
  expect(path("mail.send_message")).toBe("mail.send_message");
  expect(path("mail__send_message")).toBe("mail.send_message");
});

test("a plain name two tools share is ambiguous and lists their paths", () => {
  const resolution = resolveCatalogTool(catalog, "send_message");
  expect(resolution).toEqual({
    error: "ambiguous",
    reference: "send_message",
    candidates: ["chat.send_message", "mail.send_message"],
  });
  if ("entry" in resolution) throw new Error("expected an ambiguity");
  expect(catalogToolResolutionMessage(resolution)).toBe(
    "Ambiguous tool: send_message matches chat.send_message, mail.send_message. Use one of these paths.",
  );
});

test("an unknown name suggests the closest tools", () => {
  const resolution = resolveCatalogTool(catalog, "orders.swap");
  if ("entry" in resolution) throw new Error("expected a miss");
  expect(resolution.candidates[0]).toBe("orders_cccccc.orders_swap_item");
  expect(catalogToolResolutionMessage(resolution)).toStartWith(
    "Unknown Codemode tool: orders.swap. Closest: orders_cccccc.orders_swap_item",
  );
});

test("a call never resolves a plain name: it names the tool's server and is told the path", () => {
  // A plain name does not say which account; in a later turn it could mean another one's tool.
  expect(path("orders_cccccc.orders_swap_item", false)).toBe("orders_cccccc.orders_swap_item");
  expect(path("orders_cccccc__orders_swap_item", false)).toBe("orders_cccccc.orders_swap_item");
  const plain = resolveCatalogTool(catalog, "orders_swap_item", { allowPlainName: false });
  expect(plain).toEqual({
    error: "needs_path",
    reference: "orders_swap_item",
    candidates: ["orders_cccccc.orders_swap_item"],
  });
  if ("entry" in plain) throw new Error("expected a refusal");
  expect(catalogToolResolutionMessage(plain)).toBe(
    "Call a tool by its path, not its own name alone: orders_cccccc.orders_swap_item.",
  );
  expect(path("other.orders_swap_item", false)).toMatchObject({ error: "unknown" });
});

test("a first-party tool's hidden alias (its former name) resolves to the current tool", () => {
  const firstParty = {
    entries: [
      entry(
        "opengeni",
        "app_data_query",
        ["opengeni", "app_data_query"],
        "opengeni__app_data_query",
      ),
      entry("other", "site_data_query", ["other", "site_data_query"], "other__site_data_query"),
    ],
  };
  const resolve = (reference: string, allowPlainName?: boolean) => {
    const resolution = resolveCatalogTool(
      firstParty,
      reference,
      allowPlainName === undefined ? {} : { allowPlainName },
    );
    return "entry" in resolution ? resolution.entry.codemodePath.join(".") : resolution;
  };
  for (const reference of ["opengeni.site_data_query", "opengeni__site_data_query"]) {
    expect(resolve(reference)).toBe("opengeni.app_data_query");
    expect(resolve(reference, false)).toBe("opengeni.app_data_query");
  }
  // Another server's own tool of that name is still that tool.
  expect(resolve("other.site_data_query")).toBe("other.site_data_query");
});
