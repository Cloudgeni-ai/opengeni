import { ArrowRight, BedDouble, Car, Check, Plane, Utensils } from "lucide-react";
import type { ReactNode } from "react";
import { ease, progress } from "../lib/anim";
import { C, F } from "../theme";
import { T } from "../timeline";
import { Abs, Roll } from "./primitives";

export const ROWS_TOP = 250;
export const ROW_H = 148;
export const COLUMN_RIGHT = 924;

type RowSpec = {
  icon: ReactNode;
  time: string;
  newTime?: string;
  title: string;
  newTitle?: string;
  detail: string;
  action?: string;
  result?: string;
  chip?: string;
  /** The panel step that acts on this row. */
  stepAt?: number;
  updates?: boolean;
};

const iconProps = { size: 34, strokeWidth: 1.7, color: C.ink } as const;

const ROWS: RowSpec[] = [
  {
    icon: <Plane {...iconProps} />,
    time: "17:10",
    title: "Land in Lisbon",
    detail: "TP 1353 from London · was 14:10",
    chip: "Delayed 3h",
    stepAt: T.step1,
  },
  {
    icon: <Car {...iconProps} />,
    time: "14:40",
    newTime: "17:40",
    title: "Car pickup",
    detail: "Lisbon Airport · Desk 3",
    action: "Modify pickup",
    result: "Pickup moved",
    stepAt: T.step2,
    updates: true,
  },
  {
    icon: <BedDouble {...iconProps} />,
    time: "16:00",
    newTime: "18:30",
    title: "Hotel check-in",
    newTitle: "Late check-in",
    detail: "Casa Alfama",
    action: "Add note",
    result: "Hotel told",
    stepAt: T.step3,
    updates: true,
  },
  {
    icon: <Utensils {...iconProps} />,
    time: "19:30",
    newTime: "21:30",
    title: "Dinner for two",
    detail: "Tasca do Chico",
    action: "Change time",
    result: "Table moved",
    stepAt: T.step4,
    updates: true,
  },
];

export function Itinerary({ t }: { t: number }) {
  return (
    <>
      <Abs x={76} y={106}>
        <div style={{ fontFamily: F.display, fontSize: 60, fontWeight: 600, letterSpacing: "-0.025em", color: C.ink, lineHeight: 1 }}>
          Lisbon
        </div>
      </Abs>
      <Abs x={78} y={180} h={34}>
        {/* The product itself confirms the outcome, not just the agent's panel. */}
        <Roll
          t={t}
          at={T.allSet + 0.12}
          dur={0.6}
          style={{ height: 34 }}
          from={
            <div style={{ fontFamily: F.body, fontSize: 25, color: C.muted, letterSpacing: "-0.005em", lineHeight: "34px", whiteSpace: "nowrap" }}>
              Friday, 14 March · Day 1 of 4
            </div>
          }
          to={
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                fontFamily: F.body,
                fontSize: 25,
                fontWeight: 600,
                color: C.orange,
                letterSpacing: "-0.005em",
                lineHeight: "34px",
                whiteSpace: "nowrap",
              }}
            >
              <Check size={24} strokeWidth={2.6} />
              Replanned around your delay
            </div>
          }
        />
      </Abs>
      {ROWS.map((row, i) => (
        <Row key={row.title} t={t} row={row} top={ROWS_TOP + i * ROW_H} last={i === ROWS.length - 1} />
      ))}
    </>
  );
}

function Row({ t, row, top, last }: { t: number; row: RowSpec; top: number; last: boolean }) {
  // Attention routing: the tag lights beside the panel first, a wash sweeps leftward across
  // the row, and the time rolls as the wash reaches it — the eye follows cause to effect.
  const step = row.stepAt ?? Infinity;
  const updated = row.updates ? step + T.rowLag : Infinity;
  const sweep = ease.inOutCubic(progress(t, step + 0.06, step + 0.44));
  const washOut = ease.inOutCubic(progress(t, step + 0.95, step + 1.8));
  const bar = ease.emphasized(progress(t, step + 0.34, step + 0.62));
  const tag = ease.emphasized(progress(t, step + 0.02, step + 0.36));
  const barOpacity = row.updates ? 1 : 1 - washOut * 0.85;
  const timeStyle = {
    fontFamily: F.display,
    fontSize: 50,
    fontWeight: 600,
    letterSpacing: "-0.02em",
    color: C.ink,
    lineHeight: "60px",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  } as const;

  return (
    <>
      <Abs
        x={40}
        y={top + 1}
        w={COLUMN_RIGHT - 40 + 36}
        h={ROW_H - 2}
        style={{ background: C.orangeWash, opacity: 0.7 * (1 - washOut), clipPath: `inset(0 0 0 ${(1 - sweep) * 100}%)` }}
      />
      <Abs x={40} y={top + 18} w={6} h={(ROW_H - 36) * bar} style={{ background: C.orange, opacity: barOpacity }} />
      <Abs x={76} y={top + 42} h={60}>
        {row.newTime ? (
          <Roll t={t} at={updated} from={<div style={timeStyle}>{row.time}</div>} to={<div style={timeStyle}>{row.newTime}</div>} style={{ height: 60 }} />
        ) : (
          <div style={timeStyle}>{row.time}</div>
        )}
      </Abs>
      <Abs x={288} y={top + 55}>
        {row.icon}
      </Abs>
      <Abs x={350} y={top + 34} h={42}>
        {row.newTitle ? (
          <Roll t={t} at={updated} from={<Title>{row.title}</Title>} to={<Title>{row.newTitle}</Title>} style={{ height: 42 }} />
        ) : (
          <Title>{row.title}</Title>
        )}
      </Abs>
      <Abs x={351} y={top + 84} h={34}>
        <div style={{ display: "flex", alignItems: "center", gap: 20, height: 34 }}>
          <Detail>{row.detail}</Detail>
          {row.action && row.result ? (
            <Roll
              t={t}
              at={updated + 0.1}
              from={
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontFamily: F.body,
                    fontSize: 22,
                    fontWeight: 600,
                    color: C.ink,
                    lineHeight: "30px",
                    borderBottom: `1.5px solid ${C.ink}`,
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.action}
                  <ArrowRight size={18} strokeWidth={2.2} />
                </div>
              }
              to={
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    fontFamily: F.body,
                    fontSize: 22,
                    fontWeight: 600,
                    color: C.orange,
                    lineHeight: "30px",
                    whiteSpace: "nowrap",
                  }}
                >
                  <Check size={20} strokeWidth={2.6} />
                  {row.result}
                </div>
              }
              style={{ height: 32 }}
            />
          ) : null}
        </div>
      </Abs>
      {row.chip ? (
        <Abs x={COLUMN_RIGHT} y={top + 40} style={{ transform: "translateX(-100%)" }}>
          <div
            style={{
              fontFamily: F.mono,
              fontSize: 18,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: C.white,
              background: C.ink,
              padding: "6px 12px",
              whiteSpace: "nowrap",
            }}
          >
            {row.chip}
          </div>
        </Abs>
      ) : null}
      {row.updates ? (
        <Abs x={COLUMN_RIGHT} y={top + 44} style={{ transform: "translateX(-100%)" }}>
          <div style={{ overflow: "hidden" }}>
            <div
              style={{
                transform: `translateY(${(1 - tag) * 110}%)`,
                display: "flex",
                alignItems: "center",
                gap: 9,
                fontFamily: F.mono,
                fontSize: 18,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: C.orange,
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.orange, display: "inline-block" }} />
              By agent
            </div>
          </div>
        </Abs>
      ) : null}
      {last ? null : <Abs x={76} y={top + ROW_H - 1} w={COLUMN_RIGHT - 76} h={1.5} style={{ background: C.lineSoft }} />}
    </>
  );
}

function Title({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontFamily: F.body, fontSize: 32, fontWeight: 600, letterSpacing: "-0.015em", color: C.ink, lineHeight: "42px", whiteSpace: "nowrap" }}>
      {children}
    </div>
  );
}

function Detail({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontFamily: F.body, fontSize: 23, color: C.muted, lineHeight: "34px", whiteSpace: "nowrap" }}>{children}</div>
  );
}
