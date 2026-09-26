import { createContext, useContext } from "react";

import type { OrganizationRole, WorkspaceRole } from "../../fixtures";
import type { OrgPerson, OrgWorkspace } from "./org-data";
import type { PagePicks } from "./picks";

/* ----------------------------------------------------------------------------
   Shared state for the organization preview: people, workspaces, the open
   questions and every action, so the pages, sheets and dialogs stay in step.
   -------------------------------------------------------------------------- */

export interface OrgQuestions {
  q33: "tables" | "overview";
  q34: "removed" | "kept";
  q35: "new" | "today";
  q36: "pause" | "suspend";
  q37: "allowed" | "never";
  q38: "join" | "automatic";
  q39: "per-workspace" | "member-only";
  q40: "organization" | "local";
}

export const RECOMMENDED_ORG: OrgQuestions = {
  q33: "tables",
  q34: "removed",
  q35: "new",
  q36: "pause",
  q37: "allowed",
  q38: "join",
  q39: "per-workspace",
  q40: "organization",
};

export interface Vocabulary {
  peopleTitle: string;
  adminLabel: string;
  invite: string;
  addPeople: string;
  workspaceAccess: string;
  /** Q36: "Pause access…" or "Suspend…". */
  suspendMenu: string;
  suspendVerb: string;
  suspendedLabel: string;
  restoreLabel: string;
}

export function vocabulary(questions: OrgQuestions): Vocabulary {
  const today = questions.q35 === "today";
  const pause = questions.q36 === "pause";
  return {
    peopleTitle: today ? "People & invitations" : "People",
    adminLabel: today ? "Administrator" : "Admin",
    invite: today ? "Invite person" : "Invite people",
    addPeople: today ? "Add member" : "Add people",
    workspaceAccess: today ? "Access level" : "Workspace access",
    suspendMenu: pause ? "Pause access…" : "Suspend…",
    suspendVerb: pause ? "Pause access" : "Suspend",
    suspendedLabel: pause ? "Paused" : "Suspended",
    restoreLabel: pause ? "Resume access" : "Restore access",
  };
}

export type OrgPageId =
  | "overview"
  | "general"
  | "people"
  | "workspaces"
  | "models"
  | "integrations"
  | "identity"
  | "billing"
  | "developer"
  | "security";

export interface OrgStore {
  picks: PagePicks;
  questions: OrgQuestions;
  vocab: Vocabulary;
  local: boolean;
  people: OrgPerson[];
  workspaces: OrgWorkspace[];
  you: OrgPerson;
  /** The person or workspace whose detail is open. */
  openPersonId: string | null;
  openWorkspaceId: string | null;
  openPerson: (id: string | null) => void;
  openWorkspace: (id: string | null) => void;
  setOrganizationRole: (person: OrgPerson, role: OrganizationRole) => Promise<void>;
  setGrant: (personId: string, workspaceId: string, role: WorkspaceRole | null) => Promise<void>;
  requestSuspend: (person: OrgPerson) => void;
  requestRemove: (person: OrgPerson) => void;
  restoreAccess: (person: OrgPerson) => void;
  resendInvite: (person: OrgPerson) => void;
  revokeInvite: (person: OrgPerson) => void;
  requestJoin: (workspace: OrgWorkspace) => void;
  requestDeleteWorkspace: (workspace: OrgWorkspace) => void;
  renameWorkspace: (workspace: OrgWorkspace, name: string) => Promise<void>;
  openInvite: () => void;
  openFineTune: (person: OrgPerson, workspace: OrgWorkspace) => void;
}

export const OrgStoreContext = createContext<OrgStore | null>(null);

export function useOrg(): OrgStore {
  const store = useContext(OrgStoreContext);
  if (!store) throw new Error("useOrg needs the organization preview.");
  return store;
}

export function personStatusKey(
  person: OrgPerson,
  questions: OrgQuestions,
): "invited" | "invite_failed" | "suspended" | "paused" | null {
  if (person.status === "invited") return "invited";
  if (person.status === "invite_failed") return "invite_failed";
  if (person.status === "suspended") return questions.q36 === "pause" ? "paused" : "suspended";
  return null;
}
