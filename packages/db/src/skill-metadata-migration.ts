import { readSkillMetadata, type SkillFile } from "@opengeni/contracts";
import type postgres from "postgres";

/** Exact runner seam for 0427, not a general callback or runtime capability. */
export const SKILL_METADATA_MIGRATION_MARKER = "-- opengeni:skill-metadata-stage-v1";

export function prepareLegacySkillFolder(
  files: SkillFile[],
  legacy: { id: string; title: string; description: string },
): { files: SkillFile[]; name: string; description: string } {
  const main = files.find((file) => file.path === "SKILL.md");
  if (!main) throw new Error(`Skill ${legacy.id} requires SKILL.md before migration`);
  let content = main.content;
  // A header-looking document is never silently wrapped/repaired: missing end
  // markers, invalid YAML, invalid metadata and duplicate keys must fail closed.
  if (!/^\s*---(?:\r?\n|$)/u.test(content)) {
    const slug = legacy.title
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "");
    const name = slug && slug.length <= 64 ? slug : `legacy-${legacy.id.replaceAll("-", "")}`;
    content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(legacy.description)}\n---\n${content}`;
  }
  const metadata = readSkillMetadata(content);
  return {
    files: files.map((file) => (file.path === "SKILL.md" ? { ...file, content } : file)),
    ...metadata,
  };
}

export async function createSkillMetadataMigrationStage(
  tx: postgres.TransactionSql,
): Promise<void> {
  await tx`CREATE TEMP TABLE skill_metadata_0426 (
    source_kind text NOT NULL, source_id uuid NOT NULL, account_id uuid NOT NULL,
    workspace_id uuid, files jsonb NOT NULL, name text NOT NULL, description text NOT NULL
  ) ON COMMIT DROP`;
}

export async function stageSkillMetadataMigration(tx: postgres.TransactionSql): Promise<void> {
  const sources = await tx<
    Array<{
      source_kind: string;
      source_id: string;
      account_id: string;
      workspace_id: string | null;
      title: string;
      description: string;
      files: SkillFile[];
    }>
  >`
    SELECT 'installed' AS source_kind,sf.facet_id AS source_id,i.account_id,i.workspace_id,
      sf.name AS title,sf.description,
      coalesce(jsonb_agg(jsonb_build_object('path',ff.path,'content',ff.content) ORDER BY ff.path)
        FILTER (WHERE ff.id IS NOT NULL),'[]'::jsonb) AS files
    FROM capability_plugin_installations i JOIN capability_facets f ON f.plugin_version_id=i.plugin_version_id
    JOIN capability_skill_facets sf ON sf.facet_id=f.id LEFT JOIN capability_skill_files ff ON ff.skill_facet_id=sf.facet_id
    WHERE i.status='active'
    GROUP BY i.account_id,i.workspace_id,sf.facet_id
    UNION ALL
    SELECT 'authored',h.id,h.account_id,h.scope_workspace_id,r.title,r.description,
      coalesce(r.skill_files,jsonb_build_array(jsonb_build_object('path','SKILL.md','content',r.content)))
    FROM preference_registry_preferences h JOIN preference_registry_revisions r
      ON r.id=h.active_revision_id AND r.preference_id=h.id AND r.account_id=h.account_id
    WHERE h.status='active'
  `;
  for (const source of sources) {
    let folder: ReturnType<typeof prepareLegacySkillFolder>;
    try {
      folder = prepareLegacySkillFolder(source.files, {
        id: source.source_id,
        title: source.title,
        description: source.description,
      });
    } catch (cause) {
      throw new Error(
        `Skill ${source.source_kind}:${source.source_id} needs explicit frontmatter repair before 0427`,
        { cause },
      );
    }
    const [valid] = await tx`SELECT skill_files_valid(${tx.json(folder.files)}) AS valid`;
    if (!valid?.valid)
      throw new Error(
        `Skill ${source.source_id} exceeds the valid folder limits after metadata migration`,
      );
    await tx`INSERT INTO pg_temp.skill_metadata_0426(source_kind,source_id,account_id,workspace_id,files,name,description)
      VALUES(${source.source_kind},${source.source_id},${source.account_id},${source.workspace_id},${tx.json(folder.files)},${folder.name},${folder.description})`;
  }
}
