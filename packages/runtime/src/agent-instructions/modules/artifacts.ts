import {
  blocks,
  bullets,
  hasSandbox,
  sentences,
  toolAvailable,
  type AgentPromptModule,
} from "../types";

/**
 * Documents, published files, Sites, and inline visuals. With the markdown
 * renderer only the delivery rules remain: `artifact:` links, inline HTML, and
 * image embedding need Opengeni's timeline. Clauses naming the goal report
 * tools or `sandbox_file_publish` render unless the attempt proved them absent.
 * Clauses about sandbox files, publishing new files, workspace file links and
 * building Sites need attached compute and render only with it.
 */
export const artifactsModule: AgentPromptModule = {
  id: "artifacts",
  applies: (context) => context.capabilities.artifacts,
  render: (context) => {
    const opengeni = context.renderer === "opengeni";
    const sandbox = hasSandbox(context);
    // Reports are declared with goal_set/goal_progress and proven at goal_complete.
    const goalReports =
      context.capabilities.goals &&
      toolAvailable(context, "goal_complete") &&
      (toolAvailable(context, "goal_set") || toolAvailable(context, "goal_progress"));
    const filePublish = toolAvailable(context, "sandbox_file_publish");
    // What an ordinary answer may contain without becoming a report deliverable.
    const notReports = [
      "Ordinary in-chat answers",
      "brief progress updates",
      "internal worker findings",
      sandbox && "source-code navigation",
      sandbox && "explicitly requested local-file workflows",
    ].filter((item): item is string => typeof item === "string");
    const notReportsList =
      notReports.length > 2
        ? `${notReports.slice(0, -1).join(", ")}, and ${notReports.at(-1)}`
        : notReports.join(" and ");
    return blocks(
      "# Documents, files, and visuals",
      bullets(
        sandbox
          ? "Create a document Artifact only when the user asks for a document, asks to edit an existing document Artifact, or the deliverable is too long to read comfortably in chat (several pages). Read the documents Skill and create the native document artifact before authoring it; do not write a sandbox Markdown report first or treat publishing a file as native document creation. A Word, Excel, PDF or PowerPoint file the user sends to be changed is edited in the sandbox with ordinary tools (for example python-docx, openpyxl, pandoc or LibreOffice, installed if missing), checked and published; so is a new file the user asks for in such a format, unless the artifact export tool lists that format. Then give a short summary and the artifact link in chat, not a full restatement of the document."
          : "Create a document Artifact only when the user asks for a document, asks to edit an existing document Artifact, or the deliverable is too long to read comfortably in chat (several pages). Read the documents Skill and create the native document artifact before authoring it. Then give a short summary and the artifact link in chat, not a full restatement of the document.",
        goalReports &&
          `If the session has a goal, declare each document deliverable through the goal tools before authoring, including ones discovered after the goal was created. Inspect the relevant final artifact head after the last edit, supply its verified delivery evidence at goal completion, and give the user the artifact reference returned by the tools. ${sandbox ? "A sandbox path, a raw file ID," : "A raw file ID"} or an assertion that a report exists is not completed report delivery.`,
        `If artifact creation, inspection, access, or delivery tooling is unavailable or fails, report the concrete blocker and leave report delivery incomplete. ${sandbox ? "Do not silently fall back to a sandbox link, invent an artifact reference, or claim success." : "Do not invent an artifact reference or claim success."} ${notReportsList} do not become report deliverables merely because they contain ${sandbox ? "Markdown or a file link" : "Markdown"}.`,
      ),
      sentences(
        sandbox &&
          "Publish files you deliberately deliver so they are retained and discoverable in Artifacts; do not publish every temporary file.",
        "Reuse retained references for unchanged outputs.",
        opengeni && sandbox && "Source-code navigation may still use workspace file links.",
        opengeni &&
          (sandbox
            ? "Inline HTML stays in chat unless explicitly saved as a Site."
            : "Inline HTML stays in chat."),
        sandbox &&
          "For building, publishing, or embedding a saved Site, read the sites Skill when available.",
        sandbox
          ? "Sites and native documents keep their tool-returned canonical links."
          : "Native documents keep their tool-returned canonical links.",
        sandbox
          ? "Never substitute a storage URL or a sandbox path for a published artifact reference."
          : "Never substitute a storage URL for a published artifact reference.",
      ),
      opengeni &&
        blocks(
          "## Visuals in chat",
          "Use inline HTML when an interactive visualization materially helps the user; read the visualize Skill first. Use ordinary Markdown for simple explanations and tables.",
          sentences(
            "Display images with ![descriptive alt text](artifact:<artifactId>).",
            filePublish
              ? "Use the exact retained artifact id from an image tool or sandbox_file_publish receipt."
              : "Use the exact retained artifact id from an image tool receipt.",
            sandbox &&
              (filePublish
                ? "For a sandbox image, publish the file first; a sandbox path is not an inline image source."
                : "A sandbox path is not an inline image source."),
            "Keep image bytes, credentials, and temporary download URLs out of the response. Ordinary public image URLs also work. For custom image sizes or galleries, follow the visualize Skill; raw HTML image tags in ordinary Markdown are displayed as text.",
          ),
          "For published files, [Open file](artifact:<artifactId>) opens the retained file in Artifacts. ![Preview](artifact:<artifactId>) displays images, video, audio, or PDFs inline in the chat, with an Artifact link for other formats. Replace <artifactId> with the exact artifact.artifactId from the publication receipt and use a descriptive label.",
        ),
    );
  },
};
