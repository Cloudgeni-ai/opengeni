/**
 * The three first tasks offered on the Run in the cloud path. Two prefill the
 * new-chat composer (the person reads it and presses Send); the morning brief
 * opens the New schedule page from its template (they confirm Create
 * schedule). Nothing starts without that confirmation.
 */
export type FirstTask = Readonly<
  {
    id: "fix-issue" | "morning-brief" | "research";
    title: string;
    description: string;
  } & ({ kind: "prompt"; prompt: string } | { kind: "schedule"; template: "morning-brief" })
>;

export const FIRST_TASKS: readonly FirstTask[] = [
  {
    id: "fix-issue",
    kind: "prompt",
    title: "Fix an issue in a repo",
    description: "Point it at an issue. It finds the cause, fixes it and opens a pull request.",
    prompt:
      "Help me fix an issue in one of my GitHub repositories. Ask which repository and issue to work on, explain the cause, make the fix on a new branch, run the tests, and open a pull request once I approve the change.",
  },
  {
    id: "morning-brief",
    kind: "schedule",
    template: "morning-brief",
    title: "Weekday morning brief",
    description: "A short summary waiting for you at 08:00 every weekday.",
  },
  {
    id: "research",
    kind: "prompt",
    title: "Research a decision",
    description: "Compare the options and get a recommendation with sources.",
    prompt:
      "Help me research a decision. Ask what I am deciding and what matters most, compare the options, and recommend a next step with sources.",
  },
];
