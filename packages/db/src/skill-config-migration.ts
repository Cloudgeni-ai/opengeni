import { createHash } from "node:crypto";
import {
  StoredCapabilityPack,
  StoredSessionSkills,
  validateSkillTextFiles,
  type SkillFile,
} from "@opengeni/contracts";
import type postgres from "postgres";
import { prepareLegacySkillFolder } from "./skill-metadata-migration";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected stored configuration object");
  return value as ObjectValue;
}

/** Only known execution fields, never arbitrary metadata or archived payloads. */
export function convertLegacyConfigSkills(value: unknown, identity: string): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected stored Skill array");
  const names = new Set<string>();
  const converted = value.map((entry, index) => {
    const skill = object(entry);
    if (!Array.isArray(skill.files)) throw new Error("Expected stored Skill folder");
    const files = skill.files.map((fileEntry) => {
      const file = object(fileEntry);
      if (typeof file.path !== "string" || typeof file.content !== "string")
        throw new Error("Invalid stored Skill text file");
      if (Object.keys(file).some((key) => key !== "path" && key !== "content"))
        throw new Error("Unexpected stored Skill file fields");
      return { path: file.path, content: file.content };
    });
    const main = files.find((file) => file.path === "SKILL.md");
    const plain = main && !/^\s*---(?:\r?\n|$)/u.test(main.content);
    if (plain && (typeof skill.name !== "string" || typeof skill.description !== "string"))
      throw new Error("Plain Skill requires historical name and description");
    const folder = prepareLegacySkillFolder(files as SkillFile[], {
      id: createHash("sha256").update(`${identity}:${index}`).digest("hex").slice(0, 32),
      title: typeof skill.name === "string" ? skill.name : "",
      description: typeof skill.description === "string" ? skill.description : "",
    });
    validateSkillTextFiles(folder.files);
    if (names.has(folder.name)) throw new Error(`Canonical Skill name collision: ${folder.name}`);
    names.add(folder.name);
    // Valid YAML requires no persistence change: cached descriptors are handled
    // by the stored read projection. Preserve unknown fields and exact JSON.
    return plain ? { ...skill, ...folder } : entry;
  });
  StoredSessionSkills.parse(converted);
  return converted;
}

export function convertLegacyPackConfig(value: unknown, identity: string): ObjectValue {
  const pack = object(value);
  const converted = { ...pack };
  if (pack.skills !== undefined)
    converted.skills = convertLegacyConfigSkills(pack.skills, identity);
  if (Array.isArray(pack.automationTemplates))
    converted.automationTemplates = pack.automationTemplates.map((entry, index) => {
      const template = object(entry);
      const sessionTemplate = object(template.sessionTemplate);
      return {
        ...template,
        sessionTemplate: {
          ...sessionTemplate,
          ...(sessionTemplate.skills !== undefined
            ? {
                skills: convertLegacyConfigSkills(
                  sessionTemplate.skills,
                  `${identity}:template:${index}`,
                ),
              }
            : {}),
        },
      };
    });
  StoredCapabilityPack.parse(converted);
  return converted;
}

/** Maintenance-only: caller holds the 0423 owner window and drained runtime fence. */
export async function migrateLegacySkillConfigurations(tx: postgres.TransactionSql): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended('session-tenancy:'||workspace_id::text,0))
    FROM (SELECT DISTINCT workspace_id FROM sessions ORDER BY workspace_id) workspaces`;
  // All candidates are read under table locks, preventing changes between
  // inventory, archival, and replacement, including owner-side maintenance.
  await tx`LOCK TABLE sessions, workspace_packs, session_turns, automation_triggers,
    automation_trigger_revisions, automation_runs, automation_trigger_events, automation_run_event_links, pack_installations IN SHARE ROW EXCLUSIVE MODE`;
  const pinned = await tx<Array<{ kind: string; id: string; value: unknown }>>`
    SELECT 'pack-installation' AS kind,id::text,manifest_snapshot AS value FROM pack_installations
      WHERE status <> 'disabled' AND manifest_snapshot IS NOT NULL
    UNION ALL SELECT 'automation-current',t.id::text,jsonb_build_object('skills',r.session_template->'skills')
      FROM automation_triggers t JOIN automation_trigger_revisions r ON r.trigger_id=t.id AND r.revision=t.current_revision
      WHERE t.status IN ('active','paused') AND r.session_template ? 'skills'
    UNION ALL SELECT 'automation-run',id::text,jsonb_build_object('skills',accepted_execution->'sessionTemplate'->'skills')
      FROM automation_runs WHERE status IN ('queued','dispatching') AND accepted_execution->'sessionTemplate' ? 'skills'
    UNION ALL SELECT 'automation-event',e.id::text,jsonb_build_object('skills',r.session_template->'skills')
      FROM automation_trigger_events e CROSS JOIN LATERAL jsonb_array_elements(e.matched_trigger_revisions) matched
      JOIN automation_trigger_revisions r ON r.trigger_id=(matched->>'triggerId')::uuid AND r.revision=(matched->>'revision')::integer
      WHERE e.status='accepted' AND r.session_template ? 'skills'
        AND NOT EXISTS (SELECT 1 FROM automation_runs run WHERE run.event_id=e.id AND run.trigger_id=r.trigger_id AND run.trigger_revision=r.revision)
        AND NOT EXISTS (SELECT 1 FROM automation_run_event_links link WHERE link.event_id=e.id AND link.trigger_id=r.trigger_id)
  `;
  const blockers: string[] = [];
  for (const source of pinned) {
    try {
      const original = object(source.value);
      const converted =
        source.kind === "pack-installation"
          ? convertLegacyPackConfig(original, source.id)
          : { ...original, skills: convertLegacyConfigSkills(original.skills, source.id) };
      if (JSON.stringify(converted) !== JSON.stringify(original))
        blockers.push(`${source.kind}:${source.id} (plain content)`);
    } catch {
      blockers.push(`${source.kind}:${source.id} (invalid content)`);
    }
  }
  const candidates = await tx<
    Array<{
      kind: string;
      id: string;
      account_id: string;
      workspace_id: string;
      original: unknown;
      pinned: boolean;
    }>
  >`
    SELECT 'session' AS kind,s.id::text,s.account_id,s.workspace_id,s.skills AS original,
      (s.active_turn_id IS NOT NULL OR EXISTS(SELECT 1 FROM session_turns t WHERE t.session_id=s.id AND t.status NOT IN ('completed','failed','cancelled'))) AS pinned
      FROM sessions s WHERE s.skills <> '[]'::jsonb
    UNION ALL SELECT 'workspace-pack',id::text,account_id,workspace_id,manifest,false FROM workspace_packs
  `;
  const changes: Array<{ source: (typeof candidates)[number]; converted: unknown }> = [];
  for (const source of candidates) {
    try {
      const converted =
        source.kind === "session"
          ? convertLegacyConfigSkills(source.original, source.id)
          : convertLegacyPackConfig(source.original, source.id);
      if (source.kind === "session") StoredSessionSkills.parse(converted);
      if (JSON.stringify(source.original) !== JSON.stringify(converted)) {
        if (source.pinned) blockers.push(`${source.kind}:${source.id} (runnable accepted turn)`);
        else changes.push({ source, converted });
      }
    } catch {
      blockers.push(`${source.kind}:${source.id} (invalid content or canonical collision)`);
    }
  }
  if (blockers.length)
    throw new Error(
      `0423 Skill configuration preflight: ${blockers.length} repair-required sources; drain or explicitly replace pinned sources before retry: ${blockers.slice(0, 30).join(", ")}`,
    );
  for (const { source, converted } of changes) {
    const original = tx.json(source.original as never);
    const replacement = tx.json(converted as never);
    await tx`INSERT INTO skill_config_conversion_receipts(account_id,workspace_id,source_kind,source_id,original_configuration,original_hash,replacement_hash)
      VALUES(${source.account_id},${source.workspace_id},${source.kind},${source.id},${original},
        encode(sha256(convert_to(${original}::jsonb::text,'UTF8')),'hex'),encode(sha256(convert_to(${replacement}::jsonb::text,'UTF8')),'hex'))`;
    const updated =
      source.kind === "session"
        ? await tx`UPDATE sessions SET skills=${replacement} WHERE id=${source.id} AND account_id=${source.account_id} AND workspace_id=${source.workspace_id} AND skills=${original} RETURNING id`
        : await tx`UPDATE workspace_packs SET manifest=${replacement} WHERE id=${source.id} AND account_id=${source.account_id} AND workspace_id=${source.workspace_id} AND manifest=${original} RETURNING id`;
    if (updated.length !== 1)
      throw new Error(`0423 Skill configuration CAS conflict: ${source.kind}:${source.id}`);
  }
}
