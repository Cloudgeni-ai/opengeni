import { createContext, useContext } from "react";
import type { ToolDetails } from "./tool-presentation";

/* ----------------------------------------------------------------------------
   Tool details

   How much of each tool call the timeline shows. `full` (the default) shows
   commands, arguments, output and diffs. `plain` keeps every step visible with
   its plain name and status, and leaves out raw arguments, output and JSON, for
   products whose people should never see them. Set it once on
   `OpenGeniProvider` (`toolDetails`).
   -------------------------------------------------------------------------- */

const ToolDetailsContext = createContext<ToolDetails>("full");

export const ToolDetailsProvider = ToolDetailsContext.Provider;

export function useToolDetails(): ToolDetails {
  return useContext(ToolDetailsContext);
}
