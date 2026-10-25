/**
 * The server's transcription service: the voice input providers, their
 * credit billing, ffmpeg normalization and segmenting. Server-only (it runs
 * ffmpeg), so it is a subpath of its own rather than part of the core index.
 * The API serves one-shot voice input with it; the worker transcribes
 * dictation recordings with it.
 */
export * from "./service";
export * from "./normalize";
export * from "./segmenter";
export * from "./wav-duration";
export * from "./providers/azure-mai";
export * from "./providers/azure-openai";
export * from "./providers/codex-subscription";
export * from "./providers/openai";
export * from "./providers/subscription-core";
export * from "./providers/xai-subscription";
