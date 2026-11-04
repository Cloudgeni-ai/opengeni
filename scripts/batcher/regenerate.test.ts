import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { RestGitHub } from "./github";
import { generated, parseRegeneration, regenerationTitle, unzipText } from "./regenerate";

const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);
const TREE = "c".repeat(40);
const RUNTIME = "packages/sdk/src/site-browser-runtime.gen.ts";

/** A one-file zip archive, as GitHub serves an artifact. */
function zip(name: string, text: string, method: 0 | 8): Uint8Array {
  const raw = Buffer.from(text);
  const data = method === 8 ? deflateRawSync(raw) : raw;
  const file = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(file.length, 28);
  const directory = Buffer.concat([central, file]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(30 + file.length + data.length, 16);
  return new Uint8Array(Buffer.concat([local, file, data, directory, end]));
}

const regenerated = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    pull: 7,
    head: HEAD,
    main: MAIN,
    outcome: "regenerated",
    conflicted: [RUNTIME],
    mergedTree: TREE,
    commands: ["bun scripts/generate-site-browser-runtime.ts"],
    files: [{ path: RUNTIME, mode: "100644", content: Buffer.from("x").toString("base64") }],
    ...extra,
  });

describe("a regeneration result", () => {
  test("registered generated files, including files inside a generated directory, may be written", () => {
    expect(generated(RUNTIME)).toBe(true);
    expect(generated("scripts/public-api/surface.gen.json")).toBe(true);
    expect(generated("plugins/opengeni/skills/opengeni-setup/SKILL.md")).toBe(true);
    expect(generated("plugins/opengeni/skills/opengeni-setup-extra/SKILL.md")).toBe(false);
    expect(generated("packages/sdk/src/client.ts")).toBe(false);
  });

  test("is read only for exactly this PR head, and only when it writes generated files", () => {
    expect(parseRegeneration(regenerated(), 7, HEAD)).toMatchObject({
      outcome: "regenerated",
      mergedTree: TREE,
    });
    expect(parseRegeneration(regenerated(), 8, HEAD)).toBeNull();
    expect(parseRegeneration(regenerated(), 7, MAIN)).toBeNull();
    for (const bad of [
      { files: [{ path: ".github/workflows/ci.yml", mode: "100644", content: "eA==" }] },
      { files: [{ path: `${RUNTIME}/../../x`, mode: "100644", content: "eA==" }] },
      { files: [{ path: RUNTIME, mode: "120000", content: "eA==" }] },
      { files: [{ path: RUNTIME, mode: "100644", content: "not base64!" }] },
      {
        files: [
          { path: RUNTIME, deleted: true },
          { path: RUNTIME, deleted: true },
        ],
      },
      { conflicted: ["apps/api/src/app.ts"] },
      { conflicted: [] },
      { mergedTree: "tree" },
      { main: "main" },
      { version: 2 },
    ])
      expect(parseRegeneration(regenerated(bad), 7, HEAD)).toBeNull();
    expect(parseRegeneration("not json", 7, HEAD)).toBeNull();
    expect(
      parseRegeneration(
        regenerated({ outcome: "conflict", conflicted: ["apps/api/src/app.ts"] }),
        7,
        HEAD,
      ),
    ).toEqual({
      version: 1,
      pull: 7,
      head: HEAD,
      main: MAIN,
      outcome: "conflict",
      conflicted: ["apps/api/src/app.ts"],
    });
  });

  test("one file is read from a stored or deflated zip archive", () => {
    for (const method of [0, 8] as const) {
      const archive = zip("regeneration.json", '{"version":1}', method);
      expect(unzipText(archive, "regeneration.json")).toBe('{"version":1}');
      expect(unzipText(archive, "other.json")).toBeNull();
    }
    expect(unzipText(new Uint8Array(10), "regeneration.json")).toBeNull();
  });
});

describe("RestGitHub regeneration runs", () => {
  function client(answer: (url: string, init: RequestInit) => Response) {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), init });
      return answer(String(url), init);
    }) as unknown as typeof fetch;
    return { gh: new RestGitHub("owner/repo", "token", fetchImpl), requests };
  }
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

  test("only main's dispatched runs for exactly this head count, newest first", async () => {
    const run = (id: number, extra: Record<string, unknown> = {}) => ({
      id,
      path: ".github/workflows/regenerate-generated.yml",
      event: "workflow_dispatch",
      head_branch: "main",
      display_title: regenerationTitle(7, HEAD),
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
      html_url: `https://github.com/owner/repo/actions/runs/${id}`,
      ...extra,
    });
    const { gh, requests } = client(() =>
      json({
        workflow_runs: [
          run(1),
          run(3),
          run(4, { head_branch: "feature" }),
          run(5, { display_title: regenerationTitle(7, MAIN) }),
          run(6, { display_title: regenerationTitle(70, HEAD) }),
          run(2),
        ],
      }),
    );
    expect((await gh.regenerations(7, HEAD)).map((r) => r.id)).toEqual([3, 2, 1]);
    expect(requests[0]!.url).toBe(
      "https://api.github.com/repos/owner/repo/actions/workflows/regenerate-generated.yml/runs?event=workflow_dispatch&branch=main&per_page=100",
    );
  });

  test("a dispatch runs main's workflow for one head and one main", async () => {
    const { gh, requests } = client(() => new Response(null, { status: 204 }));
    await gh.dispatchRegeneration(7, HEAD, MAIN);
    expect(requests[0]!.url).toBe(
      "https://api.github.com/repos/owner/repo/actions/workflows/regenerate-generated.yml/dispatches",
    );
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      ref: "main",
      inputs: { pull: "7", head: HEAD, main: MAIN },
    });
  });

  test("the artifact is followed to storage without the token and unzipped", async () => {
    const archive = zip("regeneration.json", regenerated(), 8);
    const { gh, requests } = client((url) => {
      if (url.includes("/actions/runs/9/artifacts"))
        return json({
          artifacts: [
            {
              name: "regeneration",
              expired: false,
              archive_download_url: "https://api.github.com/a/1/zip",
            },
          ],
        });
      if (url === "https://api.github.com/a/1/zip")
        return new Response(null, {
          status: 302,
          headers: { location: "https://storage.test/blob?sig=1" },
        });
      return new Response(new Blob([archive as Uint8Array<ArrayBuffer>]), { status: 200 });
    });
    expect(await gh.artifactText(9, "regeneration", "regeneration.json")).toBe(regenerated());
    const headers = (index: number) => new Headers(requests[index]!.init.headers);
    expect(headers(1).get("authorization")).toBe("Bearer token");
    expect(requests[2]!.url).toBe("https://storage.test/blob?sig=1");
    expect(headers(2).get("authorization")).toBeNull();
  });

  test("a run without the artifact has no result", async () => {
    const { gh } = client(() =>
      json({ artifacts: [{ name: "regeneration", expired: true, archive_download_url: "x" }] }),
    );
    expect(await gh.artifactText(9, "regeneration", "regeneration.json")).toBeNull();
  });
});
