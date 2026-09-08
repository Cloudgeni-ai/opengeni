declare module "virtual:personal-access-baseline" {
  import type { ComponentType } from "react";
  export const PersonalResourceScopeChoice: ComponentType<{mode:"once"|"session";onModeChange:(mode:"once"|"session")=>void}>;
}