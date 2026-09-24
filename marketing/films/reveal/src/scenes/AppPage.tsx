import React from "react";
import {
  APP,
  BRAND,
  SERVICE,
  dmSans,
  inter,
} from "../theme";
import { REQUEST, T, TYPE_TIMES } from "../timeline";
import {
  BOOKED,
  GRID,
  MESSAGE_PREVIEW,
  TODAY,
  WEEK_DAYS,
  formatHour,
  hourY,
  todayRect,
  weekRect,
  type Appointment,
} from "../data/salon";
import { alpha, clamp, easeIn, easeInOut, easeOut, lerp, prog, settle } from "../lib/anim";

export const PAGE_W = 1920;
export const PAGE_H = 1080;

export const FIELD = { x: 136, y: 22, w: 964, h: 52 } as const;
export const CARD = { x: 136, y: 214, w: 660, h: 338 } as const;
export const SEND_BUTTON = { x: CARD.x + 28, y: CARD.y + CARD.h - 80, w: 252, h: 52 } as const;
const ICON = { cx: 960, cy: 452, size: 188, radius: 44 } as const;

const agentShadow = (k: number) =>
  k <= 0
    ? "none"
    : `0 0 0 ${2 * k}px ${alpha(BRAND.orange, 0.95 * k)}, 0 0 22px ${alpha(BRAND.orange, 0.28 * k)}`;

export const AppPage: React.FC<{ t: number }> = ({ t }) => {
  const closing = prog(t, T.closeStart, T.closeEnd, easeIn);
  const opening = prog(t, T.openStart, T.openEnd, easeOut);
  const morph = t < T.openStart ? closing : 1 - opening;
  const finished = t >= T.openStart;

  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: PAGE_W, height: PAGE_H }}>
      {morph < 1 ? <PageBody t={t} finished={finished} morph={morph} /> : null}
      {morph > 0 ? <ClosedApp t={t} morph={morph} /> : null}
    </div>
  );
};

const PageBody: React.FC<{ t: number; finished: boolean; morph: number }> = ({
  t,
  finished,
  morph,
}) => {
  const s = lerp(1, ICON.size / PAGE_H, morph);
  const dy = lerp(0, ICON.cy - PAGE_H / 2, morph);
  const inset = lerp(0, (PAGE_W - PAGE_H) / 2, morph);
  const radius = lerp(0, ICON.radius / (ICON.size / PAGE_H), morph);
  const contentOpacity = 1 - clamp((morph - 0.55) / 0.35);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: PAGE_W,
        height: PAGE_H,
        transformOrigin: `${PAGE_W / 2}px ${PAGE_H / 2}px`,
        transform: `translateY(${dy}px) scale(${s})`,
        clipPath: `inset(0px ${inset}px 0px ${inset}px round ${radius}px)`,
        background: morph > 0 ? APP.accent : "transparent",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: APP.bg,
          opacity: contentOpacity,
          fontFamily: inter,
          color: APP.text,
        }}
      >
        <TopBar t={t} finished={finished} />
        <CalendarFrame />
        <TodayColumn t={t} finished={finished} />
        {BOOKED.map((b, i) => (
          <BookedBlock key={i} {...b} />
        ))}
        {TODAY.map((a, i) => (
          <AppointmentBlock key={a.id} a={a} index={i} t={t} finished={finished} />
        ))}
        <Toast t={t} />
        <ApprovalCard t={t} />
        <Cursor t={t} />
      </div>
    </div>
  );
};

/* ---------- top bar ---------- */

const TopBar: React.FC<{ t: number; finished: boolean }> = ({ t, finished }) => {
  const typedCount = TYPE_TIMES.filter((time) => time <= t).length;
  const typed = REQUEST.slice(0, typedCount);
  const submitted = t >= T.enter;
  const caretOn = !submitted && (t < T.typeEnd + 0.05 || Math.floor((t - T.typeEnd) * 2.4) % 2 === 1);
  const enterFlash = prog(t, T.enter, T.enter + 0.35, easeOut);

  const moved = finished ? 6 : T.moves.filter((m) => t >= m.land).length;
  const sent = t >= T.sentTicks[T.sentTicks.length - 1];
  const status = !submitted
    ? null
    : sent
      ? { done: true, text: "All done" }
      : finished
        ? { done: true, text: "6 of 6 moved" }
        : moved > 0
          ? { done: false, text: `${moved} of 6 moved` }
          : { done: false, text: "On it" };
  const statusIn = prog(t, T.enter + 0.1, T.enter + 0.45, easeOut);

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: PAGE_W,
        height: 96,
        background: APP.surface,
        borderBottom: `1px solid ${APP.grid}`,
      }}
    >
      <ChairLogo x={48} y={26} size={44} />
      <div
        style={{
          position: "absolute",
          left: FIELD.x,
          top: FIELD.y,
          width: FIELD.w,
          height: FIELD.h,
          borderRadius: 12,
          background: submitted ? "#f7f6f2" : "#f4f3ef",
          border: `1px solid ${submitted ? APP.grid : APP.gridStrong}`,
          boxShadow: submitted ? "none" : `0 0 0 ${3 * (1 - enterFlash)}px ${alpha(APP.accent, 0)}`,
        }}
      >
        <Spark x={18} y={14} size={24} color={BRAND.orange} />
        <div
          style={{
            position: "absolute",
            left: 54,
            top: 0,
            height: FIELD.h,
            display: "flex",
            alignItems: "center",
            fontSize: 24,
            letterSpacing: -0.2,
            whiteSpace: "pre",
            color: submitted ? APP.sub : APP.text,
            maxWidth: submitted ? FIELD.w - 54 - 190 : FIELD.w - 70,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {typed.length === 0 && caretOn ? <Caret /> : null}
          {typed.length === 0 ? <span style={{ color: APP.faint }}>Hand something off…</span> : typed}
          {typed.length > 0 && caretOn ? <Caret /> : null}
        </div>
        {status ? (
          <div
            style={{
              position: "absolute",
              right: 10,
              top: 9,
              height: 34,
              padding: "0 14px 0 12px",
              borderRadius: 17,
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: status.done ? alpha(BRAND.orange, 0.1) : alpha(BRAND.orange, 0.1),
              color: BRAND.orange,
              fontSize: 16,
              fontWeight: 600,
              opacity: statusIn,
              transform: `translateX(${(1 - statusIn) * 10}px)`,
            }}
          >
            {status.done ? <Check size={15} color={BRAND.orange} /> : <Pulse t={t} />}
            {status.text}
          </div>
        ) : null}
      </div>
      <div style={{ position: "absolute", right: 104, top: 22, textAlign: "right" }}>
        <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: -0.2 }}>Studio Lena</div>
        <div style={{ fontSize: 14, color: APP.sub, marginTop: 3 }}>
          Thu 24 Sep · {finished ? "6:51" : "6:47"} AM
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          right: 48,
          top: 26,
          width: 44,
          height: 44,
          borderRadius: 22,
          background: "#dccfbd",
          color: "#4a3d2c",
          fontSize: 16,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        LO
      </div>
    </div>
  );
};

export const ChairLogo: React.FC<{ x: number; y: number; size: number }> = ({ x, y, size }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      width: size,
      height: size,
      borderRadius: size * 0.25,
      background: APP.accent,
      color: "#f4f1ea",
      fontFamily: inter,
      fontWeight: 700,
      fontSize: size * 0.62,
      lineHeight: `${size * 0.9}px`,
      textAlign: "center",
      letterSpacing: -size * 0.02,
    }}
  >
    c
  </div>
);

export const Spark: React.FC<{ x: number; y: number; size: number; color: string }> = ({
  x,
  y,
  size,
  color,
}) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    style={{ position: "absolute", left: x, top: y }}
  >
    <path
      d="M12 2.5c.5 4.6 2.9 7 9.5 9.5-6.6 2.5-9 4.9-9.5 9.5-.5-4.6-2.9-7-9.5-9.5 6.6-2.5 9-4.9 9.5-9.5z"
      fill={color}
    />
  </svg>
);

const Caret: React.FC = () => (
  <span style={{ display: "inline-block", width: 2, height: 28, margin: "0 1px", background: APP.text }} />
);

export const SparkInline: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} style={{ display: "block", flex: "none" }}>
    <path
      d="M12 2.5c.5 4.6 2.9 7 9.5 9.5-6.6 2.5-9 4.9-9.5 9.5-.5-4.6-2.9-7-9.5-9.5 6.6-2.5 9-4.9 9.5-9.5z"
      fill={color}
    />
  </svg>
);

const Pulse: React.FC<{ t: number }> = ({ t }) => {
  const k = 0.5 + 0.5 * Math.sin(t * 7);
  return (
    <span
      style={{
        width: 9,
        height: 9,
        borderRadius: 5,
        background: BRAND.orange,
        boxShadow: `0 0 0 ${3 + 3 * k}px ${alpha(BRAND.orange, 0.18 * (1 - k))}`,
      }}
    />
  );
};

export const Check: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 16 16" width={size} height={size}>
    <path
      d="M3 8.5l3.2 3L13 4.8"
      fill="none"
      stroke={color}
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/* ---------- calendar ---------- */

const CalendarFrame: React.FC = () => {
  const hours: number[] = [];
  for (let h = GRID.startHour; h <= GRID.endHour; h++) hours.push(h);
  const bottom = hourY(GRID.endHour);
  const weekRight = GRID.weekX + GRID.colWidth * 5;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: GRID.todayX,
          top: 104,
          width: GRID.colWidth,
          height: bottom - 104,
          background: "#f6f5f0",
          borderRadius: "10px 10px 0 0",
        }}
      />
      <div style={{ position: "absolute", left: GRID.todayX + 12, top: 116 }}>
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: -0.3 }}>Today</div>
        <div style={{ fontSize: 15, fontWeight: 500, color: APP.sub, marginTop: 8 }}>Thu 24 Sep</div>
      </div>
      <div style={{ position: "absolute", left: GRID.weekX + 12, top: 116 }}>
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: -0.3 }}>Next week</div>
      </div>
      {WEEK_DAYS.map((d, i) => (
        <div
          key={d.short}
          style={{
            position: "absolute",
            left: GRID.weekX + i * GRID.colWidth + 12,
            top: 156,
            fontSize: 15,
            fontWeight: 500,
            color: APP.sub,
          }}
        >
          {d.short} {d.date}
        </div>
      ))}
      {hours.map((h) => (
        <React.Fragment key={h}>
          <div
            style={{
              position: "absolute",
              left: 40,
              width: GRID.gutterRight - 40,
              top: hourY(h) - 9,
              textAlign: "right",
              fontSize: 13,
              color: APP.faint,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {h}:00
          </div>
          <div
            style={{
              position: "absolute",
              left: GRID.todayX,
              top: hourY(h),
              width: GRID.colWidth,
              height: 1,
              background: APP.grid,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: GRID.weekX,
              top: hourY(h),
              width: weekRight - GRID.weekX,
              height: 1,
              background: APP.grid,
            }}
          />
        </React.Fragment>
      ))}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: GRID.weekX + i * GRID.colWidth,
            top: 148,
            width: 1,
            height: bottom - 148,
            background: APP.grid,
          }}
        />
      ))}
    </>
  );
};

const TodayColumn: React.FC<{ t: number; finished: boolean }> = ({ t, finished }) => {
  if (!finished) {
    return (
      <>
        {TODAY.slice(0, 2).map((a, i) => {
          const left = prog(t, T.moves[i].start, T.moves[i].start + 0.25, easeOut);
          if (left <= 0) return null;
          const r = todayRect(a);
          return (
            <div
              key={a.id}
              style={{
                position: "absolute",
                left: r.x,
                top: r.y,
                width: r.w,
                height: r.h,
                borderRadius: 8,
                border: `1.5px dashed ${APP.gridStrong}`,
                opacity: left,
              }}
            />
          );
        })}
      </>
    );
  }
  const top = hourY(GRID.startHour);
  const bottom = hourY(GRID.endHour);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: GRID.todayX,
          top,
          width: GRID.colWidth,
          height: bottom - top,
          backgroundImage: `repeating-linear-gradient(135deg, ${APP.grid} 0px, ${APP.grid} 1.5px, transparent 1.5px, transparent 14px)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: GRID.todayX + 14,
          top: hourY(15) + 20,
          width: GRID.colWidth - 28,
          padding: "14px 16px",
          borderRadius: 10,
          background: APP.surface,
          border: `1px solid ${APP.grid}`,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>Out sick</div>
        <div style={{ fontSize: 14, color: APP.sub, marginTop: 4 }}>6 clients moved</div>
      </div>
    </>
  );
};

const BookedBlock: React.FC<{ day: number; start: number; duration: number; client: string }> = ({
  day,
  start,
  duration,
  client,
}) => {
  const r = weekRect(day, start, duration);
  return (
    <div
      style={{
        position: "absolute",
        left: r.x,
        top: r.y,
        width: r.w,
        height: r.h,
        borderRadius: 8,
        background: "#f4f3ef",
        border: "1px solid #e9e7e1",
      }}
    >
      <div style={{ position: "absolute", left: 13, top: 8, fontSize: 15, fontWeight: 500, color: "#a9a69e" }}>
        {client}
      </div>
      {r.h > 52 ? (
        <div style={{ position: "absolute", left: 13, top: 30, fontSize: 13, color: "#bdbab2" }}>
          {formatHour(start)}
        </div>
      ) : null}
    </div>
  );
};

function appointmentState(a: Appointment, index: number, t: number, finished: boolean) {
  const from = todayRect(a);
  const to = weekRect(a.to.day, a.to.start, a.duration);
  const scanAt = T.scanStart + index * T.scanStagger;
  const scan = prog(t, scanAt, scanAt + 0.3, easeOut);

  if (finished) {
    return { rect: to, p: 1, flying: 0, outline: 0, tag: 1, landedAt: T.openStart };
  }
  const move = T.moves[index];
  if (!move) {
    return { rect: from, p: 0, flying: 0, outline: scan, tag: 0, landedAt: Infinity };
  }
  const raw = clamp((t - move.start) / (move.land - move.start));
  const p = easeInOut(raw);
  const s = raw >= 1 ? settle(clamp((t - move.land) / 0.5) * 0.35 + 0.65) : p;
  const arc = Math.sin(Math.PI * p) * -34;
  const rect = {
    x: lerp(from.x, to.x, p),
    y: lerp(from.y, to.y, p) + arc + (raw >= 1 ? (1 - s) * 6 : 0),
    w: from.w,
    h: from.h,
  };
  const flying = raw > 0 && raw < 1 ? Math.sin(Math.PI * raw) : 0;
  const after = clamp((t - move.land) / 0.7);
  const outline = raw >= 1 ? 1 - easeOut(after) : Math.max(scan, raw > 0 ? 1 : 0);
  const tag = prog(t, move.land + 0.05, move.land + 0.4, easeOut);
  return { rect, p, flying, outline, tag, landedAt: move.land };
}

const AppointmentBlock: React.FC<{ a: Appointment; index: number; t: number; finished: boolean }> = ({
  a,
  index,
  t,
  finished,
}) => {
  const st = appointmentState(a, index, t, finished);
  const svc = SERVICE[a.kind];
  const time = st.p >= 1 ? a.to.start : a.start;
  return (
    <div
      style={{
        position: "absolute",
        left: st.rect.x,
        top: st.rect.y,
        width: st.rect.w,
        height: st.rect.h,
        borderRadius: 8,
        background: svc.fill,
        overflow: "hidden",
        zIndex: st.flying > 0 ? 5 : 2,
        transform: `scale(${1 + 0.035 * st.flying})`,
        boxShadow: [
          st.flying > 0 ? `0 ${18 * st.flying}px ${40 * st.flying}px rgba(20,20,18,${0.16 * st.flying})` : null,
          st.outline > 0 ? agentShadow(st.outline) : null,
        ]
          .filter(Boolean)
          .join(", ") || "none",
      }}
    >
      <div style={{ position: "absolute", left: 0, top: 0, width: 4, bottom: 0, background: svc.bar }} />
      <div
        style={{
          position: "absolute",
          left: 14,
          right: 12,
          top: 9,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 17, fontWeight: 600, color: svc.text, letterSpacing: -0.2 }}>
          {a.client}
        </span>
        {st.tag > 0 ? <ReasonPill text={a.reason} k={st.tag} /> : null}
      </div>
      <div
        style={{
          position: "absolute",
          left: 14,
          top: 33,
          fontSize: 13.5,
          fontWeight: 500,
          color: alpha(svc.text, 0.72),
        }}
      >
        {formatHour(time)} · {a.service}
      </div>
    </div>
  );
};

export const ReasonPill: React.FC<{ text: string; k: number }> = ({ text, k }) => (
  <span
    style={{
      fontSize: 13,
      fontWeight: 600,
      color: "#fff",
      background: BRAND.orange,
      borderRadius: 10,
      padding: "3px 9px 3px 7px",
      display: "flex",
      alignItems: "center",
      gap: 4,
      opacity: k,
      transform: `scale(${0.85 + 0.15 * k})`,
      transformOrigin: "right center",
      whiteSpace: "nowrap",
    }}
  >
    <svg viewBox="0 0 12 12" width={11} height={11}>
      <path d="M2 6h7M6.5 3.2L9.3 6 6.5 8.8" fill="none" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    {text}
  </span>
);

/* ---------- toast, approval card, cursor ---------- */

const Toast: React.FC<{ t: number }> = ({ t }) => {
  const k = prog(t, T.toast, T.toast + 0.4, easeOut) * (1 - prog(t, T.closeStart - 0.05, T.closeStart + 0.15, easeIn));
  if (k <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: PAGE_W / 2 - 420,
        width: 840,
        top: 944,
        height: 76,
        borderRadius: 38,
        background: "#1d1d1b",
        color: "#f7f6f1",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        fontSize: 28,
        fontWeight: 500,
        letterSpacing: -0.3,
        opacity: k,
        transform: `translateY(${(1 - k) * 18}px)`,
        boxShadow: "0 16px 40px rgba(20,20,18,0.22)",
        zIndex: 10,
      }}
    >
      <SparkInline size={26} color={BRAND.orange} />
      <span>You can close the app — I'll keep going.</span>
    </div>
  );
};

const ApprovalCard: React.FC<{ t: number }> = ({ t }) => {
  const inK = prog(t, T.cardIn, T.cardIn + 0.45, easeOut);
  const outK = prog(t, T.cardOut, T.cardOut + 0.35, easeIn);
  if (inK <= 0 || outK >= 1) return null;
  const press = prog(t, T.sendTap, T.sendTap + 0.08, easeOut) * (1 - prog(t, T.sendTap + 0.08, T.sendTap + 0.25, easeOut));
  const sentCount = T.sentTicks.filter((x) => t >= x).length;
  const sending = t >= T.sendTap;
  return (
    <div
      style={{
        position: "absolute",
        left: CARD.x,
        top: CARD.y,
        width: CARD.w,
        height: CARD.h,
        borderRadius: 16,
        background: APP.surface,
        border: `1px solid ${APP.gridStrong}`,
        boxShadow: "0 30px 70px rgba(20,20,18,0.16), 0 4px 14px rgba(20,20,18,0.06)",
        opacity: inK * (1 - outK),
        transform: `translateY(${(1 - inK) * 22 - outK * 10}px) scale(${1 - outK * 0.03})`,
        zIndex: 20,
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", left: 28, top: 26, display: "flex", alignItems: "center", gap: 12 }}>
        <SparkInline size={26} color={BRAND.orange} />
        <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: -0.5 }}>Done while you were away</span>
      </div>
      <div style={{ position: "absolute", left: 28, top: 74, fontSize: 19, color: APP.sub }}>
        All 6 clients moved to times that suit them.
      </div>
      <div
        style={{
          position: "absolute",
          left: 28,
          right: 28,
          top: 118,
          padding: "13px 18px 15px",
          borderRadius: 12,
          background: "#f5f4f0",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: APP.faint, letterSpacing: 0.4 }}>
          MESSAGE TO ANA RUIZ · 1 OF 6
        </div>
        <div style={{ fontSize: 19, lineHeight: 1.42, marginTop: 6, color: APP.text }}>{MESSAGE_PREVIEW}</div>
      </div>
      <div
        style={{
          position: "absolute",
          left: SEND_BUTTON.x - CARD.x,
          top: SEND_BUTTON.y - CARD.y,
          width: SEND_BUTTON.w,
          height: SEND_BUTTON.h,
          borderRadius: 10,
          background: "#1d1d1b",
          color: "#f7f6f1",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          fontSize: 19,
          fontWeight: 600,
          transform: `scale(${1 - 0.04 * press})`,
        }}
      >
        {sending ? (
          <>
            <span style={{ display: "flex", gap: 5 }}>
              {T.sentTicks.map((_, i) => (
                <span
                  key={i}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background: i < sentCount ? "#f7f6f1" : "rgba(247,246,241,0.25)",
                  }}
                />
              ))}
            </span>
            {sentCount >= 6 ? "Sent" : "Sending"}
          </>
        ) : (
          "Send 6 messages"
        )}
      </div>
      <div
        style={{
          position: "absolute",
          left: SEND_BUTTON.x - CARD.x + SEND_BUTTON.w + 12,
          top: SEND_BUTTON.y - CARD.y,
          width: 128,
          height: SEND_BUTTON.h,
          borderRadius: 10,
          border: `1px solid ${APP.gridStrong}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 19,
          fontWeight: 500,
          color: APP.text,
        }}
      >
        Review
      </div>
    </div>
  );
};

const Cursor: React.FC<{ t: number }> = ({ t }) => {
  const start = T.sendTap - 0.75;
  const k = prog(t, start, T.sendTap - 0.05, easeInOut);
  const visible = t >= start - 0.15 && t < T.cardOut + 0.2;
  if (!visible) return null;
  const fade = prog(t, start - 0.15, start, easeOut) * (1 - prog(t, T.cardOut - 0.1, T.cardOut + 0.2, easeIn));
  const tx = SEND_BUTTON.x + SEND_BUTTON.w * 0.55;
  const ty = SEND_BUTTON.y + SEND_BUTTON.h * 0.6;
  const x = lerp(tx + 240, tx, k);
  const y = lerp(ty + 150, ty, k);
  const press = prog(t, T.sendTap, T.sendTap + 0.08, easeOut) * (1 - prog(t, T.sendTap + 0.08, T.sendTap + 0.25, easeOut));
  return (
    <svg
      viewBox="0 0 24 24"
      width={34}
      height={34}
      style={{
        position: "absolute",
        left: x,
        top: y,
        zIndex: 40,
        opacity: fade,
        transform: `scale(${1 - 0.12 * press})`,
        transformOrigin: "4px 3px",
        filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.25))",
      }}
    >
      <path d="M4 2.5l15 9.2-6.6 1.3 3.9 7.3-2.7 1.4-3.9-7.3-4.8 4.6z" fill="#111" stroke="#fff" strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
};

/* ---------- closed state ---------- */

const ClosedApp: React.FC<{ t: number; morph: number }> = ({ t, morph }) => {
  const iconK = clamp((morph - 0.45) / 0.45);
  const captionK = prog(t, T.closeEnd - 0.05, T.closeEnd + 0.35, easeOut) * (1 - prog(t, T.openStart - 0.2, T.openStart + 0.05, easeIn));
  const count = 2 + T.hiddenMoves.filter((x) => t >= x).length;
  const bump = T.hiddenMoves.reduce((acc, x) => acc + Math.max(0, 1 - Math.abs(t - x - 0.06) / 0.12), 0);
  const badgeK = prog(t, T.closeEnd - 0.1, T.closeEnd + 0.2, easeOut) * (morph > 0.95 ? 1 : 0);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: ICON.cx - ICON.size / 2,
          top: ICON.cy - ICON.size / 2,
          width: ICON.size,
          height: ICON.size,
          opacity: iconK,
        }}
      >
        <ChairLogo x={0} y={0} size={ICON.size} />
        <div
          style={{
            position: "absolute",
            right: -22,
            top: -22,
            width: 64,
            height: 64,
            borderRadius: 32,
            background: BRAND.orange,
            color: "#fff",
            fontFamily: inter,
            fontSize: 28,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: `5px solid ${BRAND.paper}`,
            opacity: badgeK,
            transform: `scale(${badgeK * (1 + 0.14 * bump)})`,
          }}
        >
          {count}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          width: PAGE_W,
          top: ICON.cy + ICON.size / 2 + 54,
          textAlign: "center",
          fontFamily: dmSans,
          opacity: captionK,
          transform: `translateY(${(1 - captionK) * 10}px)`,
        }}
      >
        <div style={{ fontSize: 58, fontWeight: 500, color: BRAND.ink, letterSpacing: -1 }}>App closed.</div>
        <div style={{ fontSize: 46, fontWeight: 500, color: BRAND.orange, marginTop: 12, letterSpacing: -0.7 }}>
          The agent keeps going: {count} of 6 moved
        </div>
      </div>
    </>
  );
};
