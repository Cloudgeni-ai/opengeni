/**
 * The built-in meeting summary's message: what the agent session that
 * writes a meeting's notes is asked to do once its transcript is ready
 * (docs/recordings.md, "Built-in summary"). The "Meeting notes" automation template
 * (`automations.template.meetingNotes.instructions` in
 * `@opengeni/react`) asks for the same notes.
 *
 * Mentions are a contract with the meeting page, which renders them:
 * `[Name](speaker:<speakerLabel>)` and `[Name](person:<personId>)`, with the
 * labels and ids `meeting_read` gives.
 *
 * After a re-run, `replacesRevision` names the revision of notes an earlier
 * summary wrote that nobody has touched since: the summary writes them again
 * from the new transcript, saving over exactly that revision.
 */
export function meetingSummaryPrompt(input: {
  recordingId: string;
  title: string | null;
  replacesRevision?: number | null | undefined;
}): string {
  const title = input.title?.replace(/\s+/gu, " ").trim().slice(0, 300) || null;
  const meeting = title ? `the meeting "${title}"` : "this meeting";
  const replaces = input.replacesRevision ?? null;
  return [
    replaces === null
      ? `Write the notes for ${meeting} (meeting id ${input.recordingId}). Its transcript is ready.`
      : `Write the notes for ${meeting} (meeting id ${input.recordingId}) again. Its transcript was made again, and its notes were written from the earlier transcript.`,
    "",
    `Read the whole meeting with meeting_read and meetingId ${input.recordingId}, following nextCursor until it is null. Its details list each speaker's label, and personId for a person from the workspace, the notes people took during it (notepad) and the written-up notes with their revision. ${
      replaces === null
        ? "If that revision is above 0, someone already wrote notes: stop without changing anything."
        : `If that revision is not ${replaces}, someone changed the notes since: stop without changing anything. Otherwise write them from this transcript alone; the earlier notes may be wrong about what was said and by whom.`
    }`,
    "",
    "Write the notes in Markdown, in this order:",
    "1. A one-paragraph overview: what the meeting was about and where it ended up.",
    "2. A `##` heading for each topic discussed, with nested bullets for what was said, proposed and agreed about it.",
    '3. `## Decisions`: one bullet per decision, or "- None" when nothing was decided.',
    '4. `## Action items`: a checklist with one `- [ ]` line per task, naming its owner and its due date when one was said, or "- None" when there were none.',
    "",
    'Write all of it in the language the meeting was held in, the headings and "None" too. Use the names and terms people used, and leave out small talk.',
    "",
    "Link people when you name them: a person from the workspace (a speaker with a personId) as [Display name](person:<personId>), and any other speaker as [Display name](speaker:<label>), using exactly the labels and ids meeting_read gave. Name anyone else in plain text.",
    "",
    `Save them with meeting_notes_save: meetingId ${input.recordingId}, the Markdown as notes, and expectedRevision ${replaces ?? 0}. If it answers notes_changed, someone saved notes first: keep theirs. Then reply in one short sentence.`,
  ].join("\n");
}
