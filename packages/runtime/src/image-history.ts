import type { AgentInputItem } from "@openai/agents";

export const SCREENSHOT_OMITTED_PLACEHOLDER =
  "[screenshot omitted: an older desktop frame — the full image remains in the session event log]";

const DATA_IMAGE_BASE64_PATTERN = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/i;

type PathSegment = string | number;

type ImageOccurrence = {
  path: PathSegment[];
  replacement: unknown;
};

export type ElideStaleScreenshotsResult<T> = {
  items: T[];
  imageCount: number;
  elidedCount: number;
};

export type ElideStaleScreenshotsOptions = {
  keepLast?: number;
  placeholder?: string;
};

export function elideStaleScreenshotImages<T extends AgentInputItem>(
  items: readonly T[],
  options: ElideStaleScreenshotsOptions = {},
): ElideStaleScreenshotsResult<T> {
  const keepLast = Math.max(0, Math.floor(options.keepLast ?? 3));
  const placeholder = options.placeholder ?? SCREENSHOT_OMITTED_PLACEHOLDER;
  const occurrences: ImageOccurrence[] = [];
  for (let i = 0; i < items.length; i += 1) {
    collectItemImageOccurrences(items[i], [i], placeholder, occurrences);
  }

  const elidedCount = Math.max(0, occurrences.length - keepLast);
  if (elidedCount === 0) {
    return { items: items.slice(), imageCount: occurrences.length, elidedCount: 0 };
  }

  const cloned = structuredClone(items) as T[];
  for (const occurrence of occurrences.slice(0, elidedCount)) {
    setPath(cloned, occurrence.path, occurrence.replacement);
  }
  return { items: cloned, imageCount: occurrences.length, elidedCount };
}

function collectItemImageOccurrences(
  item: unknown,
  path: PathSegment[],
  placeholder: string,
  out: ImageOccurrence[],
): void {
  if (!isRecord(item)) {
    return;
  }
  if (item.type === "message" && (item.role === "user" || item.role === "system")) {
    return;
  }
  if (item.type === "computer_call_result" || item.type === "computer_call_output") {
    collectComputerOutputImages(item, path, placeholder, out);
    return;
  }
  if (item.type === "function_call_result" || item.type === "function_call_output") {
    collectToolResultImages(item.output, [...path, "output"], placeholder, out);
  }
}

function collectComputerOutputImages(
  item: Record<string, unknown>,
  path: PathSegment[],
  placeholder: string,
  out: ImageOccurrence[],
): void {
  const output = item.output;
  if (!isRecord(output) || output.type !== "computer_screenshot") {
    return;
  }
  for (const key of ["data", "image_url", "imageUrl"]) {
    if (isImageDataUrl(output[key])) {
      out.push({ path: [...path, "output", key], replacement: placeholder });
      return;
    }
  }
}

function collectToolResultImages(
  value: unknown,
  path: PathSegment[],
  placeholder: string,
  out: ImageOccurrence[],
): void {
  if (typeof value === "string") {
    if (isImageDataUrl(value)) {
      out.push({ path, replacement: placeholder });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectToolResultImages(value[i], [...path, i], placeholder, out);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (value.type === "input_image") {
    for (const key of ["image", "imageUrl", "image_url"]) {
      if (isImageDataUrl(value[key])) {
        out.push({ path, replacement: { type: "input_text", text: placeholder } });
        return;
      }
    }
  }
  for (const key of ["content", "text", "output"]) {
    if (key in value) {
      collectToolResultImages(value[key], [...path, key], placeholder, out);
    }
  }
}

function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && DATA_IMAGE_BASE64_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function setPath(root: unknown, path: PathSegment[], value: unknown): void {
  if (path.length === 0) {
    return;
  }
  let cursor = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i]!;
    cursor = Array.isArray(cursor)
      ? cursor[segment as number]
      : (cursor as Record<string, unknown>)[segment as string];
  }
  const last = path[path.length - 1]!;
  if (Array.isArray(cursor)) {
    cursor[last as number] = value;
  } else {
    (cursor as Record<string, unknown>)[last as string] = value;
  }
}
