import { Check } from "lucide-react";
import { ease, lerp, progress } from "../lib/anim";
import { C, F } from "../theme";
import { T } from "../timeline";
import { Abs, Eyebrow, Rise } from "./primitives";

type Kind = "dim" | "key" | "brand" | "hl";
type Tok = [text: string, kind?: Kind];

/**
 * Exact excerpt of the current SDK surface (verified in source, Sept 2026):
 *   OpenGeniClient.createSession(workspaceId, CreateSessionRequest)   packages/sdk
 *   CreateSessionRequest.tools: ToolRef[] / mcpServers: SessionMcpServerInput[]   packages/contracts
 *   <SessionConversation sessionId />   packages/react/src/components/session-conversation.tsx
 * `tripActions` is the product's own MCP server: { id: "trip", url, allowedTools, headers }.
 * The same shape is used by examples/northstar-support/src/server.ts. The comment line states
 * plainly what the excerpt leaves out.
 */
const SERVER: Tok[][] = [
  [["// after your own sign-in and tenant lookup", "dim"]],
  [["const session = await ", "dim"], ["opengeni", "brand"]],
  [["  .createSession(", "key"], ["workspaceId, {", "dim"]],
  [["    initialMessage,", "dim"]],
  [["    mcpServers: [", "key"], ["tripActions", "hl"], ["],", "key"]],
  [["    tools: [{ kind: \"mcp\", id: \"trip\" }],", "dim"]],
  [["  });", "dim"]],
];
const UI: Tok[] = [["<", "key"], ["SessionConversation", "hl"], [" sessionId={session.id} />", "key"]];

export const ACTIONS = ["get_flight", "move_car_pickup", "message_hotel", "move_dinner"];

const FONT = 56;
const LINE = 72;
const LEFT = 172;
const SERVER_TOP = 180;
const CHIPS_TOP = SERVER_TOP + SERVER.length * LINE + 24;
const UI_EYEBROW_FINAL = CHIPS_TOP + 92;
const UI_EYEBROW_SOLO = 500;

/** Everything except the two lines that matter is dimmed, so the eye knows where to go. */
const colorOf = (kind?: Kind) => (kind === "dim" ? C.faint : kind === "hl" ? C.orangeDeep : C.ink);

function Line({ toks, mark = 0 }: { toks: Tok[]; mark?: number }) {
  return (
    <div
      style={{
        fontFamily: F.mono,
        fontSize: FONT,
        lineHeight: `${LINE}px`,
        whiteSpace: "pre",
        color: C.ink,
        fontVariantLigatures: "none",
        letterSpacing: 0,
      }}
    >
      {toks.map(([text, kind], i) => (
        <span
          key={i}
          style={{
            color: colorOf(kind),
            fontWeight: kind === "brand" ? 700 : kind === "hl" ? 600 : kind === "dim" ? 400 : 500,
            ...(kind === "hl"
              ? {
                  backgroundImage: `linear-gradient(90deg, ${C.orangeWash} ${mark * 100}%, transparent ${mark * 100}%)`,
                  boxShadow: `inset 0 -3px 0 rgba(246, 83, 39, ${0.9 * mark})`,
                  padding: "0 6px",
                  margin: "0 -6px",
                }
              : {}),
          }}
        >
          {text}
        </span>
      ))}
    </div>
  );
}

/** Shown inside the opened agent panel, on the panel's own surface. */
export function CodeScene({ t }: { t: number }) {
  // Rendered inside the opening panel and clipped by it, so the panel's moving edge reveals
  // the first line and later carries the code away: no empty frame at either end.
  if (t < T.codeUI || t >= T.zoomOut[0] + 0.5) return null;
  const exit = T.zoomOut[0] + 0.12;

  const settle = ease.emphasized(progress(t, T.codeServer, T.codeServer + 0.62));
  const uiTop = lerp(UI_EYEBROW_SOLO, UI_EYEBROW_FINAL, settle);
  const markUI = ease.emphasized(progress(t, T.codeUI + 0.42, T.codeUI + 0.86));
  const markTrip = ease.emphasized(progress(t, T.codeServer + 0.5, T.codeServer + 0.94));
  const out = ease.exit(progress(t, exit, exit + 0.3));

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {t >= T.codeServer ? (
        <>
          <Abs x={LEFT} y={SERVER_TOP - 44}>
            <Rise t={t} at={T.codeServer} dur={0.5} out={exit} outDur={0.3}>
              <Eyebrow size={22} color={C.muted}>
                Your server
              </Eyebrow>
            </Rise>
          </Abs>
          {SERVER.map((toks, i) => (
            <Abs key={i} x={LEFT} y={SERVER_TOP + i * LINE}>
              <Rise t={t} at={T.codeServer + 0.04 + i * 0.04} dur={0.55} out={exit + i * 0.018} outDur={0.3}>
                <Line toks={toks} mark={markTrip} />
              </Rise>
            </Abs>
          ))}
          <Abs x={LEFT} y={CHIPS_TOP} style={{ display: "flex", alignItems: "center", gap: 14, opacity: 1 - out }}>
            <span
              style={{
                fontFamily: F.body,
                fontSize: 30,
                fontWeight: 600,
                color: C.ink,
                marginRight: 12,
                letterSpacing: "-0.01em",
                opacity: ease.outCubic(progress(t, T.codeServer + 0.7, T.codeServer + 0.95)),
                whiteSpace: "nowrap",
              }}
            >
              Your app’s own actions:
            </span>
            {ACTIONS.map((name, i) => {
              const at = T.codeServer + 0.78 + i * 0.09;
              const p = ease.emphasized(progress(t, at, at + 0.4));
              const lit = ease.emphasized(progress(t, T.chipReplay + i * T.chipGap, T.chipReplay + i * T.chipGap + 0.3));
              return (
                <span
                  key={name}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8 * lit,
                    fontFamily: F.mono,
                    fontSize: 25,
                    color: lit > 0.5 ? C.white : C.orangeDeep,
                    background: `color-mix(in srgb, ${C.orange} ${lit * 100}%, ${C.orangeWash})`,
                    padding: "8px 15px",
                    opacity: Math.min(1, p * 1.8),
                    transform: `translateY(${(1 - p) * 14}px)`,
                    whiteSpace: "nowrap",
                    fontVariantLigatures: "none",
                  }}
                >
                  <span style={{ display: "inline-flex", width: 22 * lit, overflow: "hidden" }}>
                    <Check size={22} strokeWidth={2.8} />
                  </span>
                  {name}
                </span>
              );
            })}
          </Abs>
        </>
      ) : null}

      {t >= T.codeUI ? (
        <>
          <Abs x={LEFT} y={uiTop}>
            <Rise t={t} at={T.codeUI} dur={0.5} out={exit + 0.08} outDur={0.3}>
              <Eyebrow size={22} color={C.muted}>
                Your UI · this panel
              </Eyebrow>
            </Rise>
          </Abs>
          <Abs x={LEFT} y={uiTop + 42}>
            <Rise t={t} at={T.codeUI + 0.06} dur={0.55} out={exit + 0.12} outDur={0.3}>
              <Line toks={UI} mark={markUI} />
            </Rise>
          </Abs>
        </>
      ) : null}
    </div>
  );
}
