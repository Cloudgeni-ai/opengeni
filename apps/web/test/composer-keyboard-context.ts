import type { AppContextValue } from "../src/context";

// Preview-only service boundary. All menus, input, composer, and styles are production imports.
// No rig/network access is needed for the machine keyboard paths.
const context = {
  accessContext: { subjectId: "preview", workspaceGrants: [], accountGrants: [] },
} as unknown as AppContextValue;
export const useAppContext = () => context;
export const useOptionalAppContext = () => null;
