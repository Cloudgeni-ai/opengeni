// @opengeni/sdk/chat: the one-option-object chat facade, a server handler for
// a product's own chat endpoint, and protocol adapters (native SSE, Vercel AI
// SDK UI message stream, OpenAI Chat Completions and Responses).

export { Chat, DEFAULT_CHAT_SOURCE, DEFAULT_OPENGENI_BASE_URL, OpenGeni } from "./opengeni";
export {
  OpenGeniChatError,
  type ChatAgentAccess,
  type ChatChunk,
  type ChatImportedMessage,
  type ChatMemory,
  type ChatMessage,
  type ChatOptions,
  type ChatPending,
  type ChatReply,
  type ChatReplyStatus,
  type ChatRespondInput,
  type ChatSendOptions,
  type ChatSessionListOptions,
  type ChatTarget,
  type ChatToolStatus,
  type OpenGeniOptions,
} from "./types";
export {
  CHAT_SESSION_NAMESPACE,
  chatIdempotencyKey,
  chatSessionId,
  uuidV5,
  type ChatUserLabel,
} from "./ids";
export {
  ChatTurnFold,
  approvalPending,
  humanInputPending,
  type ChatFoldStep,
  type ChatTurnTerminal,
} from "./fold";
export {
  CHAT_CONVERSATION_HEADER,
  CHAT_FORMAT_HEADER,
  chatChunksToSseBlocks,
  chatChunksToSseResponse,
  chatChunksToSseStream,
  createChatHandler,
  handleNativeChatRequest,
  handleNativeHistoryRequest,
  handleNativeRespondRequest,
  parseChatChunkStream,
  respondInputFromBody,
  type ChatHandlerFormat,
  type ChatHandlerOptions,
  type ChatResolution,
  type ChatResolve,
} from "./handler";
export {
  UI_MESSAGE_STREAM_HEADER,
  UI_MESSAGE_STREAM_VERSION,
  chatChunksToUIMessageStream,
  handleVercelChatRequest,
  lastUIMessageText,
  uiMessageStreamBlocks,
  uiMessageStreamParts,
  uiMessageStreamResponse,
  type UIMessageStreamOptions,
} from "./vercel";
export {
  chatCompletionBlocks,
  chatCompletionObject,
  decodeResponseId,
  encodeResponseId,
  handleChatCompletionsRequest,
  handleResponsesRequest,
  responsesBlocks,
  responsesInputText,
} from "./openai";
