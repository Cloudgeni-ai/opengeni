export const COMPANY_PROFILE_SCALAR_MAX_CHARS = 2_048;
export const COMPANY_PROFILE_ENTRY_MAX_CHARS = 1_024;
export const COMPANY_PROFILE_ENTRY_MAX_COUNT = 16;

export type CompanyProfileEntry = { key: string; content: string };
export type CompanyProfileContent = {
  identity: string | null;
  mission: string | null;
  products: CompanyProfileEntry[];
  customers: CompanyProfileEntry[];
  goals: CompanyProfileEntry[];
  constraints: CompanyProfileEntry[];
};
export type CompanyProfileRevisionIdentity = {
  id: string;
  revision: number;
  contentHash: string;
};
export type CompanyProfileRevision = CompanyProfileRevisionIdentity & {
  operationId: string;
  accountId: string;
  intent: "active" | "proposal";
  profile: CompanyProfileContent;
  provenance: { source: "human" | "durable_learning" | "migration"; sourceId: string | null };
  supersedesRevisionId: string | null;
  createdBySubjectId: string;
  createdAt: string;
};
export type CompanyProfileHead = {
  accountId: string;
  revisionId: string;
  revision: number;
  contentHash: string;
  activationVersion: number;
  activatedAt: string;
};
export type CompanyProfileActivationEvent = {
  id: string;
  operationId: string;
  accountId: string;
  type: "activate" | "rollback";
  activationVersion: number;
  oldRevision: CompanyProfileRevisionIdentity | null;
  newRevision: CompanyProfileRevisionIdentity | null;
  actorSubjectId: string;
  reason: string;
  createdAt: string;
};
export type CompanyProfileListOptions = { afterRevision?: number; limit?: number };
export type CompanyProfileListResponse = {
  current: CompanyProfileHead | null;
  revisions: CompanyProfileRevision[];
  activationEvents: CompanyProfileActivationEvent[];
  nextAfterRevision: number | null;
};
export type UpdateCompanyProfileRequest = {
  operationId?: string;
  profile: CompanyProfileContent;
  expectedCurrentRevisionId: string | null;
  expectedActivationVersion: number;
  reason: string;
};
export type ActivateCompanyProfileRevisionRequest = {
  operationId?: string;
  expectedCurrentRevisionId: string | null;
  expectedActivationVersion: number;
  reason: string;
};
export type RollbackCompanyProfileRequest = {
  operationId?: string;
  targetRevisionId: string;
  expectedCurrentRevisionId: string;
  expectedActivationVersion: number;
  reason: string;
};
export type CompanyProfileMutationResponse = {
  revision: CompanyProfileRevision | null;
  head: CompanyProfileHead | null;
  event: CompanyProfileActivationEvent | null;
};
export type CompanyProfileDiffRequest = { fromRevisionId: string; toRevisionId: string };
export type CompanyProfileDiffResponse = {
  from: CompanyProfileRevision;
  to: CompanyProfileRevision;
  format: "unified_json";
  diff: string;
};

export function normalizeCompanyProfileStableKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, "-").replace(/-+/g, "-");
}
