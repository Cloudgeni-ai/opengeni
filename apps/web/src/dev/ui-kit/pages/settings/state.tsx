import { createContext, useContext, type Dispatch, type SetStateAction } from "react";

import type { AccessMember } from "@/components/ui/access-list";

import type { AccessRequest, Person, WorkspaceRole } from "../../fixtures";
import type { YesNo } from "./controls";
import type { PreviewApiKey, Viewer } from "./data";
import type { SettingsNavLayout } from "./picks";
import type { FramePage } from "./settings-frame";

export type QuestionId = "q4" | "q5" | "q6" | "q7" | "q8" | "q9";

export type GeneralData = "filled" | "loading";
export type AccessData = "filled" | "only-you" | "loading" | "error";
export type ApiKeysData = "filled" | "empty" | "loading" | "error";

export interface PageData {
  general: GeneralData;
  access: AccessData;
  "api-keys": ApiKeysData;
}

export interface PauseState {
  paused: boolean;
  /** When agent work resumes; null is "until someone resumes it". */
  until: string | null;
}

/**
 * State shared by every page in one preview, so moving between General,
 * Access and API keys keeps what you changed (a rename, a pause, a new key).
 */
export interface SettingsPreviewState {
  page: FramePage;
  navigate: (page: FramePage) => void;
  viewer: Viewer;
  viewerPerson: Person;
  /** Workspace admins manage settings; members see them read-only. */
  canManage: boolean;
  questions: Record<QuestionId, YesNo>;
  data: PageData;
  setData: <K extends keyof PageData>(page: K, value: PageData[K]) => void;
  /** Navigation after question 4: the navigation pick, or the settings rail. */
  nav: SettingsNavLayout;
  workspaceName: string;
  setWorkspaceName: (name: string) => void;
  pause: PauseState;
  setPause: Dispatch<SetStateAction<PauseState>>;
  gatewayConnected: boolean;
  setGatewayConnected: (connected: boolean) => void;
  deleted: boolean;
  setDeleted: (deleted: boolean) => void;
  members: AccessMember<WorkspaceRole>[];
  setMembers: Dispatch<SetStateAction<AccessMember<WorkspaceRole>[]>>;
  requests: AccessRequest[];
  setRequests: Dispatch<SetStateAction<AccessRequest[]>>;
  keys: PreviewApiKey[];
  setKeys: Dispatch<SetStateAction<PreviewApiKey[]>>;
}

export const SettingsPreviewContext = createContext<SettingsPreviewState | null>(null);

export function useSettingsPreview(): SettingsPreviewState {
  const state = useContext(SettingsPreviewContext);
  if (!state) throw new Error("Settings pages must render inside <SettingsPreview>.");
  return state;
}
