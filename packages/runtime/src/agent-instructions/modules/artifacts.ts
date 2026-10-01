import { blocks, bullets, sentences, type AgentPromptModule } from "../types";

/**
 * Documents, published files, Sites, and inline visuals. With the markdown
 * renderer only the delivery rules remain: `artifact:` links, inline HTML, and
 * image embedding need OpenGeni's timeline.
 */
export const artifactsModule: AgentPromptModule = {
  id: "artifacts",
  applies: (context) => context.capabilities.artifacts,
  render: (context) => {
    const opengeni = context.renderer === "opengeni";
    return blocks(
      "# Documents, files, and visuals",
      bullets(
        "Create a document Artifact only when the user asks for a document or file, or when the deliverable is large (multi-page) or clearly meant to be kept or shared. Read the opengeni-documents Skill and create the native document artifact before authoring it; do not write a sandbox Markdown/DOCX report first or treat publishing a file as native document creation. Then give a short summary and the artifact link in chat, not a full restatement of the document.",
        context.capabilities.goals &&
          "If the session has a goal, declare each document deliverable through the goal tools before authoring, including ones discovered after the goal was created. Inspect the relevant final artifact head after the last edit, supply its verified delivery evidence at goal completion, and give the user the artifact reference returned by the tools. A sandbox path, a raw file ID, or an assertion that a report exists is not completed report delivery.",
        "If artifact creation, inspection, access, or delivery tooling is unavailable or fails, report the concrete blocker and leave report delivery incomplete. Do not silently fall back to a sandbox link, invent an artifact reference, or claim success. Ordinary in-chat answers, brief progress updates, internal worker findings, source-code navigation, and explicitly requested local-file workflows do not become report deliverables merely because they contain Markdown or a file link.",
      ),
      sentences(
        "Publish files you deliberately deliver so they are retained and discoverable in Artifacts; do not publish every temporary file.",
        "Reuse retained references for unchanged outputs.",
        opengeni && "Source-code navigation may still use workspace file links.",
        opengeni && "Inline HTML stays in chat unless explicitly saved as a Site.",
        "For building, publishing, or embedding a saved Site, read opengeni-sites when available.",
        "Sites and native documents keep their tool-returned canonical links.",
        "Never substitute a storage URL or a sandbox path for a published artifact reference.",
      ),
      opengeni &&
        blocks(
          "## Visuals in chat",
          "Use inline HTML when an interactive visualization materially helps the user; read the opengeni-visualize skill first. Use ordinary Markdown for simple explanations and tables.",
          "Display images with ![descriptive alt text](artifact:<artifactId>). Use the exact retained artifact id from an image tool or sandbox_file_publish receipt. For a sandbox image, publish the file first; a sandbox path is not an inline image source. Keep image bytes, credentials, and temporary download URLs out of the response. Ordinary public image URLs also work. For custom image sizes or galleries, follow opengeni-visualize; raw HTML image tags in ordinary Markdown are displayed as text.",
          "For published files, [Open file](artifact:<artifactId>) opens the retained file in Artifacts. ![Preview](artifact:<artifactId>) displays images, video, audio, or PDFs inline in the OpenGeni console, with an Artifact link for other formats. Replace <artifactId> with the exact artifact.artifactId from the publication receipt and use a descriptive label.",
        ),
    );
  },
};
