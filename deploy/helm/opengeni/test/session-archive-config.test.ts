import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseAllDocuments } from "yaml";

const helm = Bun.which("helm");
const chart = resolve(import.meta.dir, "..");

async function configMap(values: Record<string, unknown>): Promise<Record<string, string>> {
  if (!helm) throw Error("helm required for session archive config tests");
  const child = Bun.spawn([helm, "template", "archive-test", chart, "-f", "-"], {
    stdin: new Blob([JSON.stringify(values)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const map = parseAllDocuments(stdout)
    .map((document) => {
      expect(document.errors).toEqual([]);
      return document.toJS() as {
        kind?: string;
        metadata?: { name?: string };
        data?: Record<string, string>;
      };
    })
    .find((item) => item?.kind === "ConfigMap" && item.metadata?.name?.endsWith("-config"));
  return map!.data!;
}

describe("idle-session archive configuration", () => {
  test("is off by default with a thirty day idle period", async () => {
    const data = await configMap({});
    expect(data["OPENGENI_SESSION_ARCHIVE_ENABLED"]).toBe("false");
    expect(data["OPENGENI_SESSION_ARCHIVE_IDLE_DAYS"]).toBe("30");
  });

  test("follows sessionArchive values", async () => {
    const data = await configMap({ sessionArchive: { enabled: true, idleDays: 14 } });
    expect(data["OPENGENI_SESSION_ARCHIVE_ENABLED"]).toBe("true");
    expect(data["OPENGENI_SESSION_ARCHIVE_IDLE_DAYS"]).toBe("14");
  });

  test("an explicit config value wins and is not duplicated", async () => {
    const data = await configMap({
      sessionArchive: { enabled: false },
      config: { OPENGENI_SESSION_ARCHIVE_ENABLED: "true" },
    });
    expect(data["OPENGENI_SESSION_ARCHIVE_ENABLED"]).toBe("true");
  });
});
