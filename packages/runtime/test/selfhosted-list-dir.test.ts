import { describe, expect, test } from "bun:test";
import { ControlRequest, ControlResponse, FsEntryKind } from "@opengeni/agent-proto";
import { MockAgentResponder, SelfhostedSession } from "../src/sandbox";
import { discoverWorkspaceSkills } from "../src/workspace-skills";

const RELAY = { host: "relay.test", port: 443, tls: true } as const;
const WS = "11111111-1111-1111-1111-111111111111";

/** Lists the way the Connected Machine agent does (`list_dir` in the
 *  agent's native.rs): only the directory's own children, directories included,
 *  each with `path` relative to the listed directory, which is its bare name.
 *  With `reportsAbsolute`, it reports the full path instead, as the agent does
 *  when stripping the listed directory's prefix fails. */
class NativeListingResponder extends MockAgentResponder {
  constructor(
    private readonly paths: Record<string, string>,
    private readonly reportsAbsolute = false,
  ) {
    super({ files: paths });
  }

  override async request(
    subject: string,
    req: ControlRequest,
    opts: { timeoutMs: number },
  ): Promise<ControlResponse> {
    if (req.op?.$case !== "fsList") return await super.request(subject, req, opts);
    const directory = req.op.fsList.path.replace(/\/+$/u, "");
    const children = new Map<string, boolean>();
    for (const file of Object.keys(this.paths)) {
      if (!file.startsWith(`${directory}/`)) continue;
      const [name, ...rest] = file.slice(directory.length + 1).split("/");
      children.set(name!, children.get(name!) === true || rest.length > 0);
    }
    return {
      requestId: req.requestId,
      error: undefined,
      result: {
        $case: "fsList",
        fsList: {
          entries: [...children].map(([name, isDirectory]) => ({
            name,
            path: this.reportsAbsolute ? `${directory}/${name}` : name,
            kind: isDirectory
              ? FsEntryKind.FS_ENTRY_KIND_DIRECTORY
              : FsEntryKind.FS_ENTRY_KIND_FILE,
            size: "0",
            modifiedMs: "0",
            mode: 0o644,
          })),
        },
      },
    };
  }
}

function machine(
  workspaceRoot: string,
  files: Record<string, string>,
  reportsAbsolute = false,
): SelfhostedSession {
  return new SelfhostedSession({
    workspaceId: WS,
    workspaceRoot,
    agentId: "enroll-1",
    connectionInstanceId: "22222222-2222-4222-8222-222222222222",
    controlRpc: new NativeListingResponder(files, reportsAbsolute),
    relay: RELAY,
  });
}

const SKILL = "---\nname: release\ndescription: Prepare a safe release.\n---\n\n# Release\n";

describe("Connected Machine listDir paths", () => {
  const root = "/home/user/project";
  const files = {
    [`${root}/notes.txt`]: "n",
    [`${root}/.agents/skills/release/SKILL.md`]: SKILL,
    [`${root}/.agents/skills/release/references/checklist.md`]: "verify\n",
  };

  test("an absolute listing returns absolute entry paths", async () => {
    const entries = await machine(root, files).listDir({ path: `${root}/.agents/skills` });
    expect(entries).toEqual([
      { name: "release", path: `${root}/.agents/skills/release`, type: "dir" },
    ]);
  });

  test("a relative listing returns workspace-relative entry paths", async () => {
    const session = machine(root, files);
    expect(await session.listDir({ path: ".agents/skills/release" })).toEqual([
      { name: "SKILL.md", path: ".agents/skills/release/SKILL.md", type: "file" },
      { name: "references", path: ".agents/skills/release/references", type: "dir" },
    ]);
    expect(await session.listDir({ path: "" })).toEqual(
      expect.arrayContaining([
        { name: "notes.txt", path: "notes.txt", type: "file" },
        { name: ".agents", path: ".agents", type: "dir" },
      ]),
    );
  });

  test("a returned path lists again, so repository skills are discoverable", async () => {
    const session = machine(root, files);
    for (const path of [".agents/skills", `${root}/.agents/skills`]) {
      const skills = await discoverWorkspaceSkills(session, [{ path, source: ".agents/skills" }]);
      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({
        name: "release",
        description: "Prepare a safe release.",
        path: `${path}/release/SKILL.md`,
      });
    }
  });

  test("a Windows root keeps forward-slash absolute paths", async () => {
    const windowsRoot = "C:/Users/me/project";
    const session = machine(windowsRoot, {
      [`${windowsRoot}/.agents/skills/release/SKILL.md`]: SKILL,
    });
    expect(await session.listDir({ path: "C:\\Users\\me\\project\\.agents\\skills" })).toEqual([
      { name: "release", path: `${windowsRoot}/.agents/skills/release`, type: "dir" },
    ]);
    expect(await session.listDir({ path: ".agents/skills" })).toEqual([
      { name: "release", path: ".agents/skills/release", type: "dir" },
    ]);
  });

  test("a POSIX name with a backslash is joined literally", async () => {
    const session = machine(root, { [`${root}/odd\\name.txt`]: "x" });
    expect(await session.listDir({ path: root })).toEqual([
      { name: "odd\\name.txt", path: `${root}/odd\\name.txt`, type: "file" },
    ]);
    expect(await session.listDir({ path: "." })).toEqual([
      { name: "odd\\name.txt", path: "odd\\name.txt", type: "file" },
    ]);
  });

  test("an absolute path reported by the machine is kept as is", async () => {
    const session = machine(root, files, true);
    expect(await session.listDir({ path: `${root}/.agents/skills` })).toEqual([
      { name: "release", path: `${root}/.agents/skills/release`, type: "dir" },
    ]);
  });
});
