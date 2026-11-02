// The menu bar (or tray) icon while dictation is under way: small glyphs drawn
// here, so there are no image files to ship. On macOS they are template
// images (black with transparency; the menu bar colors them for light and
// dark), elsewhere they are drawn in a color that reads on the taskbar.

/** What the icon shows; "idle" is the app's own icon and is not drawn here. */
export type TrayGlyph = "starting" | "recording" | "transcribing" | "done" | "failed";

/** The transcribing icon's frames, shown about nine a second while it lasts. */
export const TRANSCRIBING_FRAMES = 8;
export const TRANSCRIBING_FRAME_MS = 110;

export interface TrayGlyphStyle {
  /** Points across (18 for the macOS menu bar). */
  size: number;
  /** Pixels per point. */
  scale: number;
  /** RGB of the glyph; black for a template image. */
  color: readonly [number, number, number];
  /** RGB of the recording dot, when it differs (red outside macOS). */
  accent?: readonly [number, number, number];
}

type Shape = (x: number, y: number) => "none" | "ink" | "accent";

/** A glyph as raw pixels, BGRA as Electron's `nativeImage.createFromBitmap` takes them. */
export function trayGlyphBitmap(
  glyph: TrayGlyph,
  style: TrayGlyphStyle,
  frame = 0,
): { width: number; height: number; scaleFactor: number; buffer: Buffer } {
  const pixels = Math.round(style.size * style.scale);
  const shape = SHAPES[glyph](frame);
  const buffer = Buffer.alloc(pixels * pixels * 4);
  // Four by four samples a pixel smooth the edges.
  const samples = 4;
  for (let row = 0; row < pixels; row += 1) {
    for (let column = 0; column < pixels; column += 1) {
      let inked = 0;
      let accent = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const hit = shape(
            (column + (sx + 0.5) / samples) / pixels,
            (row + (sy + 0.5) / samples) / pixels,
          );
          if (hit === "ink") inked += 1;
          else if (hit === "accent") accent += 1;
        }
      }
      const covered = inked + accent;
      if (covered === 0) continue;
      const color = accent > inked && style.accent ? style.accent : style.color;
      const offset = (row * pixels + column) * 4;
      buffer[offset] = color[2];
      buffer[offset + 1] = color[1];
      buffer[offset + 2] = color[0];
      buffer[offset + 3] = Math.round((255 * covered) / (samples * samples));
    }
  }
  return { width: pixels, height: pixels, scaleFactor: style.scale, buffer };
}

// Shapes in a unit square, y down.

function circle(cx: number, cy: number, r: number) {
  return (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function ring(cx: number, cy: number, r: number, width: number) {
  return (x: number, y: number) => {
    const d = Math.hypot(x - cx, y - cy);
    return d <= r + width / 2 && d >= r - width / 2;
  };
}

/** A line from a to b with round ends. */
function stroke(ax: number, ay: number, bx: number, by: number, width: number) {
  return (x: number, y: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= width / 2;
  };
}

/** A rectangle with round ends, centered on x, from top to bottom. */
function capsule(cx: number, top: number, bottom: number, width: number) {
  return stroke(cx, top + width / 2, cx, bottom - width / 2, width);
}

function ink(...parts: ((x: number, y: number) => boolean)[]): Shape {
  return (x, y) => (parts.some((part) => part(x, y)) ? "ink" : "none");
}

const SHAPES: Record<TrayGlyph, (frame: number) => Shape> = {
  // A microphone: getting ready to listen.
  starting: () => {
    const cup = ring(0.5, 0.46, 0.23, 0.08);
    return ink(
      capsule(0.5, 0.1, 0.62, 0.24),
      (x, y) => y >= 0.46 && cup(x, y),
      stroke(0.5, 0.69, 0.5, 0.86, 0.08),
      stroke(0.36, 0.88, 0.64, 0.88, 0.08),
    );
  },
  // A record button: a dot in a ring, listening now.
  recording: () => {
    const dot = circle(0.5, 0.5, 0.24);
    const edge = ring(0.5, 0.5, 0.4, 0.08);
    return (x, y) => (dot(x, y) ? "accent" : edge(x, y) ? "ink" : "none");
  },
  // Sound bars rising and falling in turn: the speech is being written down.
  transcribing: (frame) => {
    const bars = [0.18, 0.34, 0.5, 0.66, 0.82].map((cx, index) => {
      const wave = Math.sin((2 * Math.PI * frame) / TRANSCRIBING_FRAMES - index * 0.9);
      const height = 0.2 + 0.26 * (1 + wave);
      return capsule(cx, 0.5 - height / 2, 0.5 + height / 2, 0.1);
    });
    return ink(...bars);
  },
  // A check: the text is where it was going.
  done: () => ink(stroke(0.2, 0.52, 0.41, 0.73, 0.11), stroke(0.41, 0.73, 0.8, 0.29, 0.11)),
  // A warning sign with the exclamation mark cut out.
  failed: () => {
    const mark = stroke(0.5, 0.4, 0.5, 0.6, 0.09);
    const point = circle(0.5, 0.75, 0.055);
    return (x, y) => {
      if (mark(x, y) || point(x, y)) return "none";
      // Inside the triangle (0.5, 0.1), (0.94, 0.88), (0.06, 0.88), rounded a little.
      const inside = y <= 0.88 && y >= 0.1 && Math.abs(x - 0.5) <= ((y - 0.1) / 0.78) * 0.44;
      return inside ? "ink" : "none";
    };
  },
};
