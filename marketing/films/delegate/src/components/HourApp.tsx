import React from "react";
import { C } from "../theme";
import { prog } from "../anim";
import { T } from "../timeline";
import { LeftColumn, TopBar, WeekGrid } from "./AppShell";
import { Clients } from "./Clients";
import { AgentPanel } from "./AgentPanel";
import { EditDialog } from "./EditDialog";
import { Cursor } from "./Cursor";

/** The whole product, in app pixels. Everything the camera sees lives here. */
export const HourApp: React.FC<{ t: number }> = ({ t }) => {
  // Lights out after the job is done; "Rest up, Ines." and the cursor stay lit.
  const darkness = 0.72 * prog(t, T.dim, T.dim + 0.9);
  const focusScrim = prog(t, T.askClick, T.askClick + 0.3) * (1 - prog(t, T.enter + 0.05, T.enter + 0.45));
  const approvalScrim = prog(t, T.approvalIn, T.approvalIn + 0.4) * (1 - prog(t, T.approve + 0.15, T.approve + 0.5));
  const scrim = Math.max(focusScrim, approvalScrim);
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080 }}>
      <WeekGrid />
      <LeftColumn t={t} />
      <TopBar />
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
      {darkness > 0 && (
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
      )}
      <Dawn t={t} />
      <Cursor t={t} />
      <SceneFadeIn t={t} />
    </div>
  );
};

/** Before the paper rises, warm light gathers low in the frame: morning comes. */
const Dawn: React.FC<{ t: number }> = ({ t }) => {
  const k = prog(t, T.wipe - 1.0, T.wipe + 0.2);
  if (k <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: -600,
        top: -600,
        width: 3120,
        height: 2280,
        zIndex: 47,
        pointerEvents: "none",
        opacity: k,
        background: "radial-gradient(ellipse 65% 55% at 45% 95%, rgba(255,205,160,0.24) 0%, rgba(255,205,160,0.08) 45%, rgba(255,205,160,0) 72%)",
      }}
    />
  );
};

/** A 3-frame lift from black: frame 0 is still the product (it is the X thumbnail). */
const SceneFadeIn: React.FC<{ t: number }> = ({ t }) => {
  const k = Math.min(1, t / 0.05);
  if (k >= 1) return null;
  return <div style={{ position: "absolute", left: -600, top: -600, width: 3120, height: 2280, background: C.bg, opacity: 0.35 * (1 - k), zIndex: 90 }} />;
};
