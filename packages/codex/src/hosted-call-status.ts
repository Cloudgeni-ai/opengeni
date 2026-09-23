/** Hosted Responses calls require status on replay, unlike function/message annotations. */
export type HostedCallStatusItemType =
  | "hosted_tool_call"
  | "web_search_call"
  | "file_search_call"
  | "code_interpreter_call"
  | "image_generation_call";

export function preservesHostedCallStatus(type: unknown): type is HostedCallStatusItemType {
  return (
    type === "hosted_tool_call" ||
    type === "web_search_call" ||
    type === "file_search_call" ||
    type === "code_interpreter_call" ||
    type === "image_generation_call"
  );
}
