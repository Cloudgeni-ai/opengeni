// @opengeni/react/skills: a workspace's Skills page for any host. `SkillsPanel`
// is the drop-in: the list, one Skill's page with its folder editor (SKILL.md
// and supporting text files), save and remove, version history and restore
// when the client can read them, and upload of a SKILL.md, a folder or a
// .zip. The host passes its client, the scopes it offers and who may change
// what. The pieces it is built from stay available for a host's own pages.
export {
  SkillsPanel,
  SKILL_OWNER_FILTER_OPTIONS,
  skillOwnerListFilter,
  type SkillOwnerFilter,
  type SkillsClient,
  type SkillsPageSlot,
  type SkillsPanelController,
  type SkillsPanelProps,
} from "./components/skills/skills-panel";
export { SkillPage, skillStatus } from "./components/skills/skill-page";
export {
  filesFromDrop,
  readSkillUpload,
  readSkillUploadEntries,
  skillFilesProblem,
  SkillUploadError,
  unzipSkillArchive,
  type SkillUpload,
  type SkillUploadEntry,
  type UploadedFile,
} from "./components/skills/skill-upload";
export {
  humanizeName,
  scopeAudience,
  scopeLabel,
  skillBody,
  skillDisplayName,
  skillShortDescription,
  skillSummary,
} from "./app/lib/skill-names";
