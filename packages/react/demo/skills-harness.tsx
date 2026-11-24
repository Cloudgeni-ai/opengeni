import { createRoot } from "react-dom/client";
import type { SkillRecord, SkillScope, SkillSummary, SkillWriteReceipt } from "@opengeni/sdk";
import { SkillsPanel, type SkillsClient } from "@opengeni/react/skills";
import "./styles.css";

/*
 * The packaged Skills page against an in-memory client. Query parameters:
 * `?role=member` (read-only), `?empty=1` (no skills yet), `?scopes=all`
 * (personal, workspace and organization instead of a workspace-only host),
 * `?history=0` (no versions), `?theme=light`.
 */

const params = new URLSearchParams(window.location.search);
if (params.get("theme") === "light") document.documentElement.dataset.ogTheme = "light";
const member = params.get("role") === "member";
const scopes: readonly SkillScope[] =
  params.get("scopes") === "all" ? ["user", "workspace", "organization"] : ["workspace"];

function skill(
  name: string,
  description: string,
  body: string,
  extra: SkillRecord["files"] = [],
): SkillRecord {
  const id = crypto.randomUUID();
  const revision = crypto.randomUUID();
  return {
    id,
    stableKey: name,
    title: name,
    description,
    scope: "workspace",
    scopeVersion: 1,
    activationMode: "workspace_managed",
    status: "active",
    activeRevisionId: revision,
    revisionId: revision,
    pendingRevisionIds: [],
    contentHash: "9f2c".padEnd(64, "0"),
    source: null,
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
      },
      ...extra,
    ],
  };
}

const store: SkillRecord[] =
  params.get("empty") === "1"
    ? []
    : [
        skill(
          "cost-review",
          "Use when reviewing cloud spend, rightsizing resources or explaining a cost spike. Covers tagging rules and savings plans.",
          "Review cloud costs the way our FinOps team does.\n\n## Steps\n\n1. Group spend by team tag.\n2. Flag idle resources older than 14 days.",
          [
            {
              path: "references/tagging.md",
              content: "# Tagging rules\n\nEvery resource carries `team` and `env`.",
            },
          ],
        ),
        skill(
          "incident-review",
          "Use when writing a post-incident review. Gives the timeline format and the questions to answer.",
          "Write incident reviews that are blameless and short.",
        ),
        skill(
          "terraform-style",
          "Use when writing or reviewing Terraform. Module layout, naming and the checks to run before a plan.",
          "Follow the module layout in this repository.",
        ),
      ];
const versions = new Map<string, number>(store.map((entry) => [entry.id, 1]));

const wait = () => new Promise((resolve) => setTimeout(resolve, 250));
const summary = ({ files: _files, ...rest }: SkillRecord): SkillSummary => rest;

const client: SkillsClient = {
  async listWorkspaceSkills() {
    await wait();
    return { skills: store.map(summary), nextCursor: null };
  },
  async readWorkspaceSkill(_workspaceId, skillId) {
    await wait();
    const found = store.find((entry) => entry.id === skillId);
    if (!found) throw new Error("Skill not found");
    return found;
  },
  async saveWorkspaceSkill(_workspaceId, request) {
    await wait();
    const header = request.files.find((file) => file.path === "SKILL.md")!.content;
    const name = /^name:\s*(.+)$/mu.exec(header)?.[1]?.trim() ?? request.stableKey;
    const description = /^description:\s*(.+)$/mu.exec(header)?.[1]?.trim() ?? "";
    const revision = crypto.randomUUID();
    const index = store.findIndex((entry) => entry.id === request.skillId);
    const previous = store[index];
    const next: SkillRecord = {
      ...(previous ?? skill(name, description, "")),
      id: request.skillId,
      stableKey: previous?.stableKey ?? request.stableKey,
      title: name,
      description,
      activeRevisionId: revision,
      revisionId: revision,
      files: request.files,
    };
    if (index >= 0) store[index] = next;
    else store.push(next);
    versions.set(next.id, (versions.get(next.id) ?? 0) + 1);
    return {
      skillId: next.id,
      revisionId: revision,
      outcome: "applied",
      operationId: request.operationId,
      replayed: false,
    } as SkillWriteReceipt;
  },
  async removeWorkspaceSkill(_workspaceId, skillId) {
    await wait();
    store.splice(
      store.findIndex((entry) => entry.id === skillId),
      1,
    );
    return {
      skillId,
      removed: true,
      operationId: "remove",
      outcome: "applied",
    } as SkillWriteReceipt;
  },
  ...(params.get("history") === "0"
    ? {}
    : {
        async getPreferenceRegistry(_workspaceId: string, skillId: string) {
          const found = store.find((entry) => entry.id === skillId)!;
          const count = versions.get(skillId) ?? 1;
          return {
            revisions: Array.from({ length: count }, (_, index) => ({
              id: index === count - 1 ? found.activeRevisionId! : `${skillId}-${index}`,
              revision: index + 1,
            })).reverse(),
          } as never;
        },
      }),
};

function Harness() {
  return (
    <div className="min-h-screen bg-og-bg text-og-fg">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <SkillsPanel
          client={client}
          workspaceId="ws-demo"
          scopes={scopes}
          canManage={() => !member}
          description="Instructions agents in this workspace load when a task needs them."
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
