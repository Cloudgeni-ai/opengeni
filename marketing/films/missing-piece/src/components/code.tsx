import { ease, lerp, progress } from "../lib/anim";
import { C, F } from "../theme";
import { T } from "../timeline";
import { Abs, Eyebrow, Rise } from "./primitives";

type Tok = [text: string, kind?: "dim" | "key" | "brand" | "hl"];

/**
 * Exact excerpt of the current SDK surface (verified in source, Sept 2026):
 *   OpenGeniClient.createSession(workspaceId, CreateSessionRequest)   packages/sdk
 *   CreateSessionRequest.tools: ToolRef[] / mcpServers: SessionMcpServerInput[]   packages/contracts
 *   <SessionConversation sessionId />   packages/react/src/components/session-conversation.tsx
 * `tripActions` is the product's own MCP server: { id: "trip", url, allowedTools, headers }.
 * The same shape is used by examples/northstar-support/src/server.ts.
 */
const SERVER: Tok[][] = [
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
const CHAR = FONT * 0.6;
const LINE = 76;
const LEFT = 172;
const SERVER_TOP = 184;
const CHIPS_TOP = SERVER_TOP + SERVER.length * LINE + 26;
const UI_EYEBROW_FINAL = CHIPS_TOP + 96;
const UI_EYEBROW_SOLO = 500;

/** Everything except the two lines that matter is dimmed, so the eye knows where to go. */
const colorOf = (kind?: Tok[1]) => (kind === "dim" ? C.faint : kind === "hl" ? C.orange : C.ink);

function Line({ toks }: { toks: Tok[] }) {
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
        <span key={i} style={{ color: colorOf(kind), fontWeight: kind === "brand" ? 700 : kind === "hl" ? 600 : kind === "dim" ? 400 : 500 }}>
          {text}
        </span>
      ))}
    </div>
  );
}

const cols = (toks: Tok[], upto: number) => toks.slice(0, upto).reduce((n, [text]) => n + text.length, 0);

/** Shown inside the zoomed agent panel, on the panel's own surface colour. */
export function CodeScene({ t }: { t: number }) {
  if (t < T.zoomIn[1] || t >= T.zoomOut[0]) return null;
  const exit = T.zoomOut[0] - 0.36;

  const settle = ease.emphasized(progress(t, T.codeServer, T.codeServer + 0.62));
  const uiTop = lerp(UI_EYEBROW_SOLO, UI_EYEBROW_FINAL, settle);

  const hlUI = ease.emphasized(progress(t, T.codeUI + 0.42, T.codeUI + 0.82));
  const hlTrip = ease.emphasized(progress(t, T.codeServer + 0.5, T.codeServer + 0.9));
  const tripX = LEFT + cols(SERVER[3]!, 1) * CHAR;
  const tripW = "tripActions".length * CHAR;
  const scX = LEFT + CHAR;
  const scW = "SessionConversation".length * CHAR;
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
              <Rise t={t} at={T.codeServer + 0.05 + i * 0.045} dur={0.55} out={exit + i * 0.02} outDur={0.3}>
                <Line toks={toks} />
              </Rise>
            </Abs>
          ))}
          <Abs
            x={tripX}
            y={SERVER_TOP + 4 * LINE - 12}
            w={tripW * hlTrip}
            h={4}
            style={{ background: C.orange, opacity: 1 - out }}
          />
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
              return (
                <span
                  key={name}
                  style={{
                    fontFamily: F.mono,
                    fontSize: 25,
                    color: C.orangeDeep,
                    background: C.orangeWash,
                    padding: "8px 15px",
                    opacity: Math.min(1, p * 1.8),
                    transform: `translateY(${(1 - p) * 14}px)`,
                    whiteSpace: "nowrap",
                    fontVariantLigatures: "none",
                  }}
                >
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
              <Line toks={UI} />
            </Rise>
          </Abs>
          <Abs x={scX} y={uiTop + 42 + LINE - 12} w={scW * hlUI} h={4} style={{ background: C.orange, opacity: 1 - out }} />
        </>
      ) : null}

      <Abs x={LEFT} y={1006} style={{ opacity: ease.outCubic(progress(t, T.codeServer + 0.9, T.codeServer + 1.3)) * (1 - out) }}>
        <div style={{ fontFamily: F.mono, fontSize: 18, letterSpacing: "0.06em", color: C.faint, textTransform: "uppercase" }}>
          Excerpt · your auth, tenant mapping and action endpoint are not shown
        </div>
      </Abs>
    </div>
  );
}
