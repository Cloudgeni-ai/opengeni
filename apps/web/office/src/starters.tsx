import type { SessionStarter } from "@opengeni/react/session-app";
import { BarChart3, FileSearch, ListChecks, Sigma, Sparkles, TableProperties } from "lucide-react";

const iconClass = "size-5";

/**
 * The pane's suggestions under the composer: things people do in a
 * spreadsheet, worked in the open workbook. Plain editable prompts.
 */
export const SPREADSHEET_STARTERS: readonly SessionStarter[] = [
  {
    id: "explain-sheet",
    title: "Explain this sheet",
    description: "What the data is and what stands out.",
    prompt:
      "Explain the active sheet: what the data is, how it's laid out, how the formulas fit together, and anything that stands out.",
    icon: <FileSearch className={iconClass} />,
  },
  {
    id: "check-errors",
    title: "Check for mistakes",
    description: "Broken formulas, duplicates and odd values.",
    prompt:
      "Check the selected range, or the whole sheet if nothing is selected, for mistakes: broken or inconsistent formulas, duplicates, typos and values that look wrong. List what you find before changing anything.",
    icon: <ListChecks className={iconClass} />,
  },
  {
    id: "formula",
    title: "Write a formula",
    description: "Describe the result, get a working formula.",
    prompt:
      "Help me write a formula. Ask what I want to calculate and where, then add it to the sheet and explain how it works.",
    icon: <Sigma className={iconClass} />,
  },
  {
    id: "summarize",
    title: "Summarize the data",
    description: "Totals and breakdowns on a new sheet.",
    prompt:
      "Summarize the data in the active sheet on a new sheet: totals and breakdowns by the main categories, with a short note on what stands out.",
    icon: <TableProperties className={iconClass} />,
  },
  {
    id: "chart",
    title: "Make a chart",
    description: "The chart that fits the selected data.",
    prompt:
      "Make a chart from the selected data. Pick the chart type that fits it best, tell me why, and add it next to the data.",
    icon: <BarChart3 className={iconClass} />,
  },
  {
    id: "clean-up",
    title: "Clean up a table",
    description: "Consistent formats, dates and headers.",
    prompt:
      "Clean up the selected table: consistent number and date formats, trimmed text, clear headers and no stray blank rows. Tell me what you'll change before you change it.",
    icon: <Sparkles className={iconClass} />,
  },
];
