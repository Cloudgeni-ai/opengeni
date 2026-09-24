import { ease, progress } from "../lib/anim";
import { C, F } from "../theme";
import { T } from "../timeline";
import { Abs, Eyebrow } from "./primitives";

type Tok = [text: string, kind?: "kw" | "str" | "punct" | "brand" | "hl" | "dim"];

/**
 * Exact excerpt of the current SDK surface (verified in source):
 *   OpenGeniClient.createSession(workspaceId, CreateSessionRequest) — packages/sdk
 *   tools: ToolRef[], mcpServers: SessionMcpServerInput[] — packages/contracts
 *   <SessionConversation sessionId /> — packages/react/src/components/session-conversation.tsx
 * `tripActions` is the product's MCP server config ({ id: "trip", url, allowedTools, headers }).
 */
const SERVER: Tok[][] = [
  [["const", "kw"], [" session = "], ["await", "kw"], [" "], ["opengeni", "brand"], [".createSession(workspaceId, {"]],
  [["  initialMessage,"]],
  [["  mcpServers: ["], ["tripActions", "hl"], ["],"]],
  [["  tools: [{ kind: "], ['"mcp"', "str"], [", id: "], ['"trip"', "str"], [" }],"]],
  [["});"]],
];
const UI: Tok[] = [["<"], ["SessionConversation", "hl"], [" sessionId={session.id} />"]];

export const ACTIONS = ["get_flight", "move_car_pickup", "message_hotel", "move_dinner"];

const FONT = 44;
const CHAR = FONT * 0.6;
const LINE = 66;
const LEFT = 190;
const TOP = 206;

const colorOf = (kind?: Tok[1]) =>
  kind === "kw"
    ? C.muted2
    : kind === "str"
      ? "#6b5d4f"
      : kind === "punct"
        ? C.muted
        : kind === "hl"
          ? C.orange
          : kind === "dim"
            ? C.faint
            : C.ink;

function Line({ toks }: { toks: Tok[] }) {
  return (
    <div style={{ fontFamily: F.mono, fontSize: FONT, lineHeight: `${LINE}px`, whiteSpace: "pre", letterSpacing: 0, color: C.ink, fontVariantLigatures: "none" }}>
      {toks.map(([text, kind], i) => (
        <span key={i} style={{ color: colorOf(kind), fontWeight: kind === "brand" ? 700 : kind === "hl" ? 600 : 450 }}>
          {text}
        </span>
      ))}
    </div>
  );
}

const cols = (toks: Tok[], upto: number) => toks.slice(0, upto).reduce((n, [text]) => n + text.length, 0);

export function CodeScene({ t }: { t: number }) {
  const hl1 = ease.emphasized(progress(t, T.code + 0.55, T.code + 0.95));
  const hl2 = ease.emphasized(progress(t, T.code + 1.55, T.code + 1.95));

  const tripCol = cols(SERVER[2]!, 1);
  const tripX = LEFT + tripCol * CHAR;
  const tripW = "tripActions".length * CHAR;
  const line3Bottom = TOP + 52 + 3 * LINE;
  const chipsTop = TOP + 52 + 5 * LINE + 46;
  const uiTop = chipsTop + 132;
  const scX = LEFT + CHAR;
  const scW = "SessionConversation".length * CHAR;

  return (
    <div style={{ position: "absolute", inset: 0, background: C.paper }}>
      <Abs x={LEFT} y={TOP}>
        <Eyebrow size={22} color={C.muted}>
          Your server
        </Eyebrow>
      </Abs>
      <Abs x={LEFT} y={TOP + 52}>
        {SERVER.map((toks, i) => (
          <Line key={i} toks={toks} />
        ))}
      </Abs>
      <Abs x={tripX} y={line3Bottom - 8} w={tripW * hl1} h={3} style={{ background: C.orange }} />

      <Abs x={LEFT} y={chipsTop} style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span
          style={{
            fontFamily: F.body,
            fontSize: 28,
            fontWeight: 550,
            color: C.ink,
            marginRight: 10,
            opacity: ease.outCubic(progress(t, T.code + 0.95, T.code + 1.2)),
            whiteSpace: "nowrap",
          }}
        >
          Your app’s own actions:
        </span>
        {ACTIONS.map((name, i) => {
          const at = T.code + 1.0 + i * 0.1;
          const p = ease.emphasized(progress(t, at, at + 0.4));
          return (
            <span
              key={name}
              style={{
                fontFamily: F.mono,
                fontSize: 23,
                color: C.orangeDeep,
                background: C.orangeWash,
                padding: "8px 14px",
                opacity: Math.min(1, p * 1.8),
                transform: `translateY(${(1 - p) * 14}px)`,
                whiteSpace: "nowrap",
              }}
            >
              {name}
            </span>
          );
        })}
      </Abs>

      <Abs x={LEFT} y={uiTop}>
        <Eyebrow size={22} color={C.muted}>
          Your UI
        </Eyebrow>
      </Abs>
      <Abs x={LEFT} y={uiTop + 52}>
        <Line toks={UI} />
      </Abs>
      <Abs x={scX} y={uiTop + 52 + LINE - 8} w={scW * hl2} h={3} style={{ background: C.orange }} />

      <Abs x={LEFT} y={992}>
        <div style={{ fontFamily: F.mono, fontSize: 18, letterSpacing: "0.06em", color: C.faint, textTransform: "uppercase" }}>
          Excerpt · your auth, tenant mapping and action endpoint are not shown
        </div>
      </Abs>
    </div>
  );
}
