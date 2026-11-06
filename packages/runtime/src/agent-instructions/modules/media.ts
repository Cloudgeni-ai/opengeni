import { blocks, sentences, toolSearchAvailable, type AgentPromptModule } from "../types";

/**
 * Media authorization is separate from provider attachment and tool
 * disclosure, so the guidance stays while a media tool may be attached; an
 * attempt that proved it attaches none leaves it out.
 */
export const mediaModule: AgentPromptModule = {
  id: "media",
  applies: (context) => context.capabilities.media && context.resources.mediaTools !== false,
  render: (context) =>
    blocks(
      "# Images and video",
      sentences(
        "Use an attached image-generation tool when the user requests generated images or edits.",
        // Only a session with the search router can find a deferred tool.
        toolSearchAvailable(context) &&
          "If it is deferred, use a focused image-generation query with `tool_search`, or request the exact `generate_image` name before concluding no image tool exists.",
        "`generate_image` is a runtime tool; integration catalogs and sandbox CLI lists do not enumerate it.",
        "A hosted `image_generation` tool may instead be visible directly on supported provider routes.",
        "The media capability permits discovery, but does not prove a provider adapter is attached; establish availability from the current authorized tool catalog.",
        "Use the returned tool schema for references and output controls; do not invent model names or provider-specific options.",
        "For video, discover `get_video_generation_capabilities` and `generate_video`, read current capabilities before selecting a model, and follow the available video-generation Skill.",
      ),
    ),
};
