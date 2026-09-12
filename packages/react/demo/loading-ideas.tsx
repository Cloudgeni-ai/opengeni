import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal, ChevronRight, Pause, Play, Sun, Moon } from "lucide-react";
import "./styles.css";
import "./loading-ideas.css";
const ideas = [
  [
    "ink-sweep",
    "Bright sweep",
    "A broad bright band travels through the letterforms.",
    "Recommended",
  ],
  [
    "ink-breathe",
    "Full-line breath",
    "All the text brightens together, then gently settles.",
    "Recommended",
  ],
  ["ink-ripple", "Letter ripple", "Brightness travels letter by letter with no movement.", ""],
  ["ink-wave", "Soft text wave", "A tiny vertical wave passes through the letters.", ""],
  ["ink-glint", "Sharp glint", "A narrow high-contrast gleam slides across the text.", ""],
  ["ink-tide", "Slow tide", "A wide highlight rolls back and forth through the line.", ""],
  ["ink-glow", "Luminous breath", "The text gently brightens and gains a fine halo.", ""],
  ["ink-weight", "Weight pulse", "The strokes subtly gain weight while remaining aligned.", ""],
  ["ink-warm", "Warm current", "A soft warm highlight moves through otherwise neutral text.", ""],
  ["ink-lift", "Whole-line float", "The entire line lifts one pixel as it brightens.", ""],
  ["ink-double", "Double glint", "Two light bands circulate through the text.", ""],
  ["ink-roll", "Gentle tilt", "The whole line tilts slightly without disappearing.", ""],
];
function App() {
  const [dark, setDark] = useState(true),
    [paused, setPaused] = useState(false),
    [speed, setSpeed] = useState("2.4s"),
    [text, setText] = useState("bun run typecheck"),
    [chosen, setChosen] = useState("ink-sweep");
  return (
    <main
      className={`ideas ${dark ? "dark" : "light"} ${paused ? "paused" : ""}`}
      style={{ "--tempo": speed } as React.CSSProperties}
    >
      <div className="ideas-shell">
        <header>
          <span className="eyebrow">OPENGENI / MOTION LAB</span>
          <button onClick={() => setDark(!dark)} aria-label="Switch theme">
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </header>
        <section className="intro">
          <div>
            <h1>Alive. Not distracting.</h1>
            <p>
              Twelve directions for long-running work.
              <br />
              Same row. Different signals. Nothing here changes the app.
            </p>
          </div>
          <span className="note">
            Click a card to shortlist it.
            <br />
            Watch for a few seconds.
          </span>
        </section>
        <div className="controls">
          <button onClick={() => setPaused(!paused)}>
            {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? "Play" : "Pause"}
          </button>
          <label>
            Rhythm{" "}
            <select value={speed} onChange={(e) => setSpeed(e.target.value)}>
              <option value="1.5s">Lively</option>
              <option value="2.4s">Balanced</option>
              <option value="3.6s">Slow</option>
            </select>
          </label>
          <label>
            Command{" "}
            <select value={text} onChange={(e) => setText(e.target.value)}>
              <option>bun run typecheck</option>
              <option>Thinking through the implementation</option>
              <option>Reading repository documentation and tracing dependencies</option>
            </select>
          </label>
        </div>
        <div className="ideas-grid">
          {ideas.map(([id, title, description, badge], i) => (
            <button
              key={id}
              onClick={() => setChosen(id!)}
              aria-pressed={chosen === id}
              className={`idea ${chosen === id ? "selected" : ""}`}
            >
              <div className="card-top">
                <span>{String(i + 1).padStart(2, "0")}</span>
                {badge && <span className="badge">{badge}</span>}
              </div>
              <div className={`sample ${id}`}>
                <ChevronRight size={13} className="chevron" />
                <span className="tool">
                  <Terminal size={15} />
                  <span className="orbit-ring" />
                  <span className="ticks-ring">
                    {Array.from({ length: 8 }, (_, n) => (
                      <i key={n} style={{ "--n": n } as React.CSSProperties} />
                    ))}
                  </span>
                </span>
                <span className="command">
                  {Array.from(text).map((char, n) => (
                    <span
                      key={text.slice(0, n + 1)}
                      style={{ "--letter": n } as React.CSSProperties}
                    >
                      {char}
                    </span>
                  ))}
                </span>
                <span className="tail" aria-hidden="true">
                  {Array.from({ length: 5 }, (_, n) => (
                    <i key={n} style={{ "--n": n } as React.CSSProperties} />
                  ))}
                </span>
              </div>
              <div className="caption">
                <h2>{title}</h2>
                <p>{description}</p>
              </div>
            </button>
          ))}
        </div>
        <footer>
          <span>
            Shortlisted: <strong>{ideas.find((x) => x[0] === chosen)?.[1]}</strong>
          </span>
          <span>Animations respect reduced motion · Concept study</span>
        </footer>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
