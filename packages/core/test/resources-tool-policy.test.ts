import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { assertToolRefsSubset, validateToolRefsForSessionPolicy } from "../src/domain/resources";
import type { ToolRef } from "@opengeni/contracts";

const settings = {
  mcpServers: [
    { id: "opengeni", url: "https://platform.example/mcp", cacheToolsList: false },
    { id: "cap-docs", url: "https://docs.example/mcp", cacheToolsList: false },
    { id: "static-configured", url: "https://static.example/mcp", cacheToolsList: false },
  ],
};
const mcp = (id: string, optional?: boolean): ToolRef => ({
  kind: "mcp",
  id,
  ...(optional ? { optional: true } : {}),
});

describe("session resource tool policy fences", () => {
  test("fixed policies reject widening and allow a strict narrowing", () => {
    expect(() => assertToolRefsSubset([mcp("static-configured")], [mcp("cap-docs")])).toThrow(
      HTTPException,
    );
    expect(() => assertToolRefsSubset([mcp("cap-docs")], [mcp("cap-docs")])).not.toThrow();

    expect(() =>
      validateToolRefsForSessionPolicy({
        requested: [mcp("static-configured")],
        settings,
        allowedTools: [mcp("cap-docs")],
        message: "narrowing required",
      }),
    ).toThrow(HTTPException);
  });

  test("workspace defaults allow only the current effective default set", () => {
    expect(() =>
      validateToolRefsForSessionPolicy({
        requested: [mcp("static-configured")],
        settings,
        allowedTools: [mcp("opengeni"), mcp("cap-docs")],
        message: "narrowing required",
      }),
    ).toThrow(HTTPException);
    expect(
      validateToolRefsForSessionPolicy({
        requested: [mcp("cap-docs")],
        settings,
        allowedTools: [mcp("opengeni"), mcp("cap-docs")],
        message: "narrowing required",
      }),
    ).toEqual([mcp("cap-docs")]);
  });

  test("optional unknown refs degrade while strict unknown refs reject", () => {
    expect(
      validateToolRefsForSessionPolicy({
        requested: [mcp("optional-portable", true)],
        settings,
        allowedTools: [],
        message: "narrowing required",
      }),
    ).toEqual([]);
    expect(() =>
      validateToolRefsForSessionPolicy({
        requested: [mcp("strict-unknown")],
        settings,
        allowedTools: [],
        message: "narrowing required",
      }),
    ).toThrow(HTTPException);
  });
});
