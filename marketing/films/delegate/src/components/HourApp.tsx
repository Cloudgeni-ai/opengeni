import React from "react";
import { C } from "../theme";
import { prog, springAt } from "../anim";
import { T } from "../timeline";
import { LeftColumn, TopBar, WeekGrid } from "./AppShell";
import { Clients } from "./Clients";
import { AgentPanel } from "./AgentPanel";
import { EditDialog } from "./EditDialog";
import { Cursor } from "./Cursor";
import { HourFlipWordmark } from "./Flip";

/** The whole product, in app pixels. Everything the camera sees lives here. */
export const HourApp: React.FC<{ t: number }> = ({ t }) => {
  // Lights out, then only the product's name stays lit while the camera finds it.
  const darkness = Math.min(1, 0.38 * prog(t, T.dim, T.dim + 0.7) + 0.62 * prog(t, T.toMark + 0.05, T.toMark + 0.5));
  const chromeFade = 1 - prog(t, T.toMark + 0.1, T.toMark + 0.7);
  const handoff = t >= T.wipe;
  const focusScrim = prog(t, T.askClick, T.askClick + 0.3) * (1 - prog(t, T.enter + 0.05, T.enter + 0.45));
  const approvalScrim = prog(t, T.approvalIn, T.approvalIn + 0.4) * (1 - prog(t, T.approve + 0.15, T.approve + 0.5));
  const scrim = Math.max(focusScrim, approvalScrim);
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080 }}>
      <WeekGrid />
      <LeftColumn t={t} />
      <TopBar hideWordmark detailsOpacity={chromeFade} />
      {!handoff && <HourFlipWordmark t={t} />}
      <Clients t={t} />
      {scrim > 0 && (
        <div
          style={{
            position: "absolute",
            left: -600,
            top: -600,
            width: 3120,
            height: 2280,
            background: `rgba(4,5,7,${0.5 * scrim})`,
            zIndex: 35,
          }}
        />
      )}
      <AgentPanel t={t} />
      <EditDialog t={t} />
      <div
        style={{
          position: "absolute",
          left: -600,
          top: -600,
          width: 3120,
          height: 2280,
          background: `rgba(11,12,15,${darkness})`,
          zIndex: 45,
          pointerEvents: "none",
        }}
      />
      <Cursor t={t} />
      <SceneFadeIn t={t} />
    </div>
  );
};

/** A 3-frame lift from black: frame 0 is still the product (it is the X thumbnail). */
const SceneFadeIn: React.FC<{ t: number }> = ({ t }) => {
  const k = Math.min(1, t / 0.05);
  if (k >= 1) return null;
  return <div style={{ position: "absolute", left: -600, top: -600, width: 3120, height: 2280, background: C.bg, opacity: 0.35 * (1 - k), zIndex: 90 }} />;
};
