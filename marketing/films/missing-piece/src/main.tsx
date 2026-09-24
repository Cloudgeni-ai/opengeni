import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Film } from "./film";
import { H, W } from "./theme";
import { FPS, TOTAL_FRAMES, audioCues } from "./timeline";

declare global {
  interface Window {
    __ready?: boolean;
    __setFrame?: (frame: number) => Promise<void>;
    __meta?: { fps: number; frames: number; width: number; height: number };
    __cues?: ReturnType<typeof audioCues>;
  }
}

const params = new URLSearchParams(location.search);
const renderMode = params.has("render");
const root = createRoot(document.getElementById("root")!);

const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function preload() {
  await document.fonts.ready;
  const faces = ['600 60px "Archivo"', '500 30px "DM Sans"', '400 30px "JetBrains Mono"', '400 20px "Inter"'];
  await Promise.all(faces.map((face) => document.fonts.load(face)));
  await Promise.all(
    ["sparkles", "weary", "pray"].map(
      (name) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => resolve();
          img.onerror = () => resolve();
          img.src = `assets/emoji/${name}.png`;
        }),
    ),
  );
}

if (renderMode) {
  document.body.classList.add("render");
  window.__meta = { fps: FPS, frames: TOTAL_FRAMES, width: W, height: H };
  window.__cues = audioCues();
  window.__setFrame = async (frame: number) => {
    flushSync(() => root.render(<Film frame={frame} />));
    await nextPaint();
  };
  void preload().then(async () => {
    await window.__setFrame!(Number(params.get("frame") ?? 0));
    window.__ready = true;
  });
} else {
  root.render(<Player />);
}

/** Browser preview: real-time playback with a scrubber. Space toggles play. */
function Player() {
  const [frame, setFrame] = useState(Number(params.get("frame") ?? 0));
  const [playing, setPlaying] = useState(false);
  const [scale, setScale] = useState(1);
  const start = useRef<{ wall: number; frame: number } | null>(null);

  useEffect(() => {
    const fit = () => setScale(Math.min((innerWidth - 40) / W, (innerHeight - 110) / H));
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    start.current = { wall: performance.now(), frame };
    const tick = () => {
      const s = start.current!;
      const f = s.frame + Math.floor(((performance.now() - s.wall) / 1000) * FPS);
      if (f >= TOTAL_FRAMES) {
        setFrame(TOTAL_FRAMES - 1);
        setPlaying(false);
        return;
      }
      setFrame(f);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.code === "ArrowRight") setFrame((f) => Math.min(TOTAL_FRAMES - 1, f + (e.shiftKey ? FPS : 1)));
      if (e.code === "ArrowLeft") setFrame((f) => Math.max(0, f - (e.shiftKey ? FPS : 1)));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <div style={{ padding: 20, color: "#eee", fontFamily: "JetBrains Mono, monospace", fontSize: 13 }}>
      <div style={{ width: W * scale, height: H * scale, overflow: "hidden" }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0" }}>
          <Film frame={frame} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 14 }}>
        <button onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
        <input
          type="range"
          min={0}
          max={TOTAL_FRAMES - 1}
          value={frame}
          onChange={(e) => {
            setPlaying(false);
            setFrame(Number(e.target.value));
          }}
          style={{ flex: 1 }}
        />
        <span>
          {(frame / FPS).toFixed(2)}s · frame {frame}/{TOTAL_FRAMES}
        </span>
      </div>
    </div>
  );
}
