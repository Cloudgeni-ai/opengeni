import { LatestFrameSubscription } from "./media";

export type ComputerImageFrame = Readonly<{
  frameId: string;
  computerSessionId: string;
  controllerGeneration: string;
  targetId: string;
  targetGeneration: string;
  sequence: number;
  mediaType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  data: Uint8Array;
  capturedAt: string;
}>;

export type ComputerFrameStreamOptions = Readonly<{
  format?: "jpeg" | "png";
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}>;

export type NormalizedComputerFrameStreamOptions = Readonly<{
  format: "jpeg" | "png";
  quality: number;
  maxWidth: number;
  maxHeight: number;
  everyNthFrame: number;
}>;

export interface ComputerFrameSubscription extends AsyncIterable<ComputerImageFrame> {
  close(): Promise<void>;
}

export class LatestComputerFrameSubscription
  extends LatestFrameSubscription<ComputerImageFrame>
  implements ComputerFrameSubscription {}

export function normalizeComputerFrameStreamOptions(
  options: ComputerFrameStreamOptions = {},
): NormalizedComputerFrameStreamOptions {
  return {
    format: options.format ?? "jpeg",
    quality: boundedInteger(options.quality ?? 70, 1, 100, "frame quality"),
    maxWidth: boundedInteger(options.maxWidth ?? 4_096, 1, 4_096, "frame width"),
    maxHeight: boundedInteger(options.maxHeight ?? 4_096, 1, 4_096, "frame height"),
    everyNthFrame: boundedInteger(options.everyNthFrame ?? 1, 1, 60, "frame sampling interval"),
  };
}

export function sameComputerFrameOptions(
  left: NormalizedComputerFrameStreamOptions,
  right: NormalizedComputerFrameStreamOptions,
): boolean {
  return (
    left.format === right.format &&
    left.quality === right.quality &&
    left.maxWidth === right.maxWidth &&
    left.maxHeight === right.maxHeight &&
    left.everyNthFrame === right.everyNthFrame
  );
}

export function computerFrameStreamProfileKey(
  options: NormalizedComputerFrameStreamOptions,
): string {
  return [
    options.format,
    options.quality,
    options.maxWidth,
    options.maxHeight,
    options.everyNthFrame,
  ].join(":");
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`computer ${label} must be a bounded integer`);
  }
  return value;
}
