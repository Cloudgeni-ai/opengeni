// Where the main window opens. Pure, so the rules are testable without Electron.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** What window.json holds: the normal (unmaximized) bounds and whether it was maximized. */
export interface SavedWindow extends Rect {
  maximized?: boolean;
}

export interface Placement {
  bounds: Partial<Rect> & Size;
  /** Maximize once the window is on screen. */
  maximize: boolean;
}

export const MIN_SIZE: Size = { width: 720, height: 520 };
export const DEFAULT_SIZE: Size = { width: 1280, height: 860 };

export function placeWindow(input: {
  saved: SavedWindow | null;
  workAreas: Rect[];
  primary: Rect;
  platform: NodeJS.Platform;
}): Placement {
  const { saved, workAreas, platform } = input;
  const visibleOn = saved
    ? workAreas.find(
        (area) =>
          saved.x < area.x + area.width - 80 &&
          saved.x + saved.width > area.x + 80 &&
          saved.y >= area.y - 10 &&
          saved.y < area.y + area.height - 80,
      )
    : undefined;
  const usable =
    saved && visibleOn && saved.width >= MIN_SIZE.width && saved.height >= MIN_SIZE.height;
  const area = usable ? visibleOn : input.primary;
  const bounds: Partial<Rect> & Size = usable
    ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
    : {
        width: Math.min(DEFAULT_SIZE.width, area.width - 80),
        height: Math.min(DEFAULT_SIZE.height, area.height - 80),
      };
  return {
    bounds,
    // macOS has no maximized state to restore; zoom is not the same thing.
    maximize: platform !== "darwin" && Boolean(usable && saved.maximized),
  };
}
