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
 * The notes also name the meeting: `meeting_notes_save` keeps the name only
 * while the meeting has none from a person or a calendar event.
 */
export function meetingSummaryPrompt(input: {
  recordingId: string;
  title: string | null;
  /** A title that is only a date or an app's guess says nothing about the meeting. */
  titleSource?: "person" | "calendar" | "conversation" | "app" | "default" | undefined;
}): string {
  const named = input.titleSource !== "default" && input.titleSource !== "app";
  // A calendar title may come from whoever sent the invitation: it stays one
  // quoted line of text, never a way out of its quotes.
  const title =
    (named && input.title?.replace(/\s+/gu, " ").replaceAll('"', "'").trim().slice(0, 300)) || null;
  const meeting = title ? `the meeting "${title}"` : "this meeting";
  return [
    `Write the notes for ${meeting} (meeting id ${input.recordingId}). Its transcript is ready.`,
    "",
    `Read the whole meeting with meeting_read and meetingId ${input.recordingId}, following nextCursor until it is null. Its details list each speaker's label, and personId for a person from the workspace, the notes people took during it (notepad) and the written-up notes with their revision. If that revision is above 0, someone already wrote notes: stop without changing anything.`,
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
    "Name the meeting too: a title of at most eight words saying what it was about, in the meeting's language, such as the main topic and who it was with. No date, no quotes, and not a generic word like Meeting or Call.",
    "",
    `Save them with meeting_notes_save: meetingId ${input.recordingId}, the Markdown as notes, the name as title, and expectedRevision 0. The name is kept only if nobody named the meeting yet. If it answers notes_changed, someone saved notes first: keep theirs. Then reply in one short sentence.`,
  ].join("\n");
}
