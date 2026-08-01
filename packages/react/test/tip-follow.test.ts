import { describe, expect, test } from "bun:test";
import {
  createTipFollowState,
  readerScrollUpPx,
  tipFollowCancel,
  tipFollowCompensateShrink,
  tipFollowNoteGrowth,
  tipFollowStep,
  tipFollowTauMs,
  TIP_FOLLOW_HOT_IDLE_MS,
  TIP_FOLLOW_LINE_GROWTH_PX,
  TIP_FOLLOW_LINE_TAU_MS,
  TIP_FOLLOW_SETTLE_TAU_MS,
  TIP_FOLLOW_SNAP_PX,
  TIP_FOLLOW_TAU_MAX_MS,
  TIP_FOLLOW_TAU_MIN_MS,
  TIP_FOLLOW_VELOCITY_ARM_DEBT_PX,
} from "../src/components/tip-follow";
import { MOTION_INSPECT_SCALE } from "../src/lib/motion-inspect";

describe("tipFollowCompensateShrink", () => {
  test("at tip, shrink keeps the tip glued (same as maxScroll fall)", () => {
    expect(tipFollowCompensateShrink(1600, 2000, 1500, 400)).toBe(1100);
  });

  test("mid-document shrink preserves on-screen pixels", () => {
    expect(tipFollowCompensateShrink(1000, 2000, 1500, 400)).toBe(500);
  });

  test("non-shrink leaves scrollTop alone", () => {
    expect(tipFollowCompensateShrink(1600, 2000, 2000, 400)).toBe(1600);
  });

  test("tiny reflow shrink is ignored (no micro bob)", () => {
    expect(tipFollowCompensateShrink(1600, 2000, 1998, 400)).toBe(1600);
  });
});

describe("readerScrollUpPx", () => {
  test("fold/composer clamp is not reader intent", () => {
    expect(readerScrollUpPx(1600, 1100, 1600, 1100)).toBe(0);
  });

  test("real scroll-up while maxScroll holds is reader intent", () => {
    expect(readerScrollUpPx(1600, 1400, 1600, 1600)).toBe(200);
  });

  test("growth increasing maxScroll does not invent reader-up", () => {
    expect(readerScrollUpPx(1600, 1600, 1600, 1900)).toBe(0);
  });
});

describe("tipFollowTauMs", () => {
  test("small debt is calm; large debt catches up", () => {
    expect(tipFollowTauMs(8, 0)).toBeGreaterThan(tipFollowTauMs(120, 0));
    expect(tipFollowTauMs(0, 0)).toBe(TIP_FOLLOW_TAU_MAX_MS);
    expect(tipFollowTauMs(10_000, 0)).toBe(TIP_FOLLOW_TAU_MIN_MS);
  });

  test("velocity does not yank near the tip; arms once tip-debt piles up", () => {
    expect(tipFollowTauMs(28, 800)).toBe(tipFollowTauMs(28, 0));
    const behind = TIP_FOLLOW_VELOCITY_ARM_DEBT_PX + 40;
    expect(tipFollowTauMs(behind, 800)).toBeLessThan(tipFollowTauMs(behind, 0));
  });

  test("hot floors urgency above calm; idle settle uses longer τ", () => {
    expect(tipFollowTauMs(28, 0, false, true)).toBeLessThan(tipFollowTauMs(28, 0, false, false));
    expect(tipFollowTauMs(28, 0, true)).toBe(TIP_FOLLOW_SETTLE_TAU_MS);
    expect(TIP_FOLLOW_SETTLE_TAU_MS).toBeGreaterThan(TIP_FOLLOW_TAU_MAX_MS);
  });

  test("hot line-sized debt uses the short line τ", () => {
    expect(tipFollowTauMs(28, 0, false, true)).toBe(TIP_FOLLOW_LINE_TAU_MS);
  });
});

describe("tipFollowNoteGrowth", () => {
  test("positive growth extends the hot window", () => {
    let state = createTipFollowState();
    state = tipFollowNoteGrowth(state, 1000, 1000);
    state = tipFollowNoteGrowth(state, 1024, 1100);
    expect(state.hotUntil).toBe(1100 + TIP_FOLLOW_HOT_IDLE_MS);
    expect(state.lastHeight).toBe(1024);
  });
});

describe("tipFollowStep", () => {
  test("line growth eases in — first frame is not a hard bite of Δh", () => {
    expect(28).toBeLessThanOrEqual(TIP_FOLLOW_LINE_GROWTH_PX);
    let state = createTipFollowState();
    state = tipFollowNoteGrowth(state, 2000, 0);
    const first = tipFollowStep(state, {
      scrollTop: 1600,
      scrollHeight: 2028,
      clientHeight: 400,
      now: 10,
      pinned: true,
      reducedMotion: false,
      revealed: true,
    });
    const moved = first.scrollTop - 1600;
    // Soft accel: well under half a line on frame 0; velocity is armed.
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(28 * 0.35);
    expect(first.state.scrollVelocity).toBeGreaterThan(0);
    expect(first.state.running).toBe(true);

    // Later frames move more as velocity rises (ease-in), then settle.
    let scrollTop = first.scrollTop;
    state = first.state;
    let peakStep = moved;
    for (let i = 0; i < 8; i += 1) {
      const next = tipFollowStep(state, {
        scrollTop,
        scrollHeight: 2028,
        clientHeight: 400,
        now: 10 + (i + 1) * 16,
        pinned: true,
        reducedMotion: false,
        revealed: true,
      });
      peakStep = Math.max(peakStep, next.scrollTop - scrollTop);
      scrollTop = next.scrollTop;
      state = next.state;
    }
    expect(peakStep).toBeGreaterThan(moved);
  });

  test("camera never overshoots the tip", () => {
    let state = createTipFollowState();
    state = tipFollowNoteGrowth(state, 2000, 0);
    state = { ...state, scrollVelocity: 2000 }; // huge leftover velocity
    const next = tipFollowStep(state, {
      scrollTop: 1610,
      scrollHeight: 2020,
      clientHeight: 400,
      now: 20,
      pinned: true,
      reducedMotion: false,
      revealed: true,
    });
    expect(next.scrollTop).toBeLessThanOrEqual(1620);
    if (next.scrollTop === 1620) {
      expect(next.state.scrollVelocity).toBe(0);
    }
  });

  test("sparse line while behind still eases without a one-frame snap", () => {
    let state = createTipFollowState();
    state = tipFollowNoteGrowth(state, 2000, 0);
    const first = tipFollowStep(state, {
      scrollTop: 1400,
      scrollHeight: 2028,
      clientHeight: 400,
      now: 10,
      pinned: true,
      reducedMotion: false,
      revealed: true,
    });
    expect(first.scrollTop).toBeGreaterThan(1400);
    expect(first.scrollTop).toBeLessThan(1628);
    expect(first.state.running).toBe(true);
  });

  test("idle settle decelerates into the tip; growth breaks out to catch-up", () => {
    let state = createTipFollowState();
    state = tipFollowNoteGrowth(state, 2000, 0);
    state = {
      ...state,
      lastHeight: 2040,
      hotUntil: 0,
      lastTs: 5_000,
      scrollVelocity: 0,
    };
    const settle = tipFollowStep(state, {
      scrollTop: 1620,
      scrollHeight: 2040,
      clientHeight: 400,
      now: 5_000 + 16,
      pinned: true,
      reducedMotion: false,
      revealed: true,
    });
    const settleDelta = settle.scrollTop - 1620;
    expect(settleDelta).toBeGreaterThan(0);
    expect(settleDelta).toBeLessThan(8);

    let scrollTop = settle.scrollTop;
    const breakout = tipFollowStep(settle.state, {
      scrollTop,
      scrollHeight: 2100,
      clientHeight: 400,
      now: 5_000 + 37 * 16,
      pinned: true,
      reducedMotion: false,
      revealed: true,
    });
    expect(breakout.scrollTop - scrollTop).toBeGreaterThan(0);
  });

  test("growthVelocity decays when height is flat", () => {
    let state = {
      ...createTipFollowState(),
      lastHeight: 2000,
      hotUntil: 0,
      growthVelocity: 200,
      lastTs: 1000,
    };
    const next = tipFollowStep(state, {
      scrollTop: 1580,
      scrollHeight: 2000,
      clientHeight: 400,
      now: 1080,
      pinned: true,
      reducedMotion: false,
      revealed: true,
    });
    expect(next.state.growthVelocity).toBeLessThan(200);
    expect(next.state.growthVelocity).toBeGreaterThan(0);
  });

  test("large tip-debt catches up faster than a calm one-line debt", () => {
    const run = (debt: number) => {
      let state = createTipFollowState();
      const height = 400 + 1600 + debt;
      state = tipFollowNoteGrowth(state, height - debt, 0);
      state = tipFollowNoteGrowth(state, height, 5);
      const stepped = tipFollowStep(state, {
        scrollTop: 1600,
        scrollHeight: height,
        clientHeight: 400,
        now: 5,
        pinned: true,
        reducedMotion: false,
        revealed: true,
      });
      // Compare after a short accel window so velocity has risen.
      let scrollTop = stepped.scrollTop;
      state = stepped.state;
      for (let i = 0; i < 6; i += 1) {
        const next = tipFollowStep(state, {
          scrollTop,
          scrollHeight: height,
          clientHeight: 400,
          now: 5 + (i + 1) * 16,
          pinned: true,
          reducedMotion: false,
          revealed: true,
        });
        scrollTop = next.scrollTop;
        state = next.state;
      }
      return scrollTop - 1600;
    };
    expect(run(280)).toBeGreaterThan(run(28));
  });

  test("large wall eases in then reaches tip without a one-frame glue", () => {
    let state = createTipFollowState();
    state = tipFollowNoteGrowth(state, 2000, 0);
    const wall = tipFollowStep(state, {
      scrollTop: 1600,
      scrollHeight: 2000 + 320,
      clientHeight: 400,
      now: 26,
      pinned: true,
      reducedMotion: false,
      revealed: true,
    });
    expect(wall.scrollTop - 1600).toBeLessThan(80);
    expect(wall.state.running).toBe(true);

    let scrollTop = wall.scrollTop;
    state = wall.state;
    const easeFrames = 50 * MOTION_INSPECT_SCALE;
    for (let i = 0; i < easeFrames; i += 1) {
      const next = tipFollowStep(state, {
        scrollTop,
        scrollHeight: 2320,
        clientHeight: 400,
        now: 26 + (i + 1) * 16,
        pinned: true,
        reducedMotion: false,
        revealed: true,
      });
      scrollTop = next.scrollTop;
      state = next.state;
    }
    expect(2320 - 400 - scrollTop).toBeLessThan(48);
  });

  test("token stream stays near tip without hard line snaps", () => {
    let state = createTipFollowState();
    let height = 2000;
    let scrollTop = 1600;
    state = tipFollowNoteGrowth(state, height, 0);
    let maxFrameStep = 0;
    for (let i = 0; i < 90; i += 1) {
      height += 3;
      const next = tipFollowStep(state, {
        scrollTop,
        scrollHeight: height,
        clientHeight: 400,
        now: 16 + i * 16,
        pinned: true,
        reducedMotion: false,
        revealed: true,
      });
      maxFrameStep = Math.max(maxFrameStep, next.scrollTop - scrollTop);
      scrollTop = next.scrollTop;
      state = next.state;
    }
    const tip = height - 400;
    // Spring lags a little under inspect scale; must not snap whole lines.
    expect(tip - scrollTop).toBeLessThan(80 * MOTION_INSPECT_SCALE);
    expect(maxFrameStep).toBeLessThan(24);
  });

  test("line-sized frames: accel then settle, never a full-line snap", () => {
    let state = createTipFollowState();
    let height = 2000;
    let scrollTop = 1600;
    state = tipFollowNoteGrowth(state, height, 0);
    const line = 24;
    let maxFrameStep = 0;
    for (let i = 0; i < 8; i += 1) {
      height += line;
      const next = tipFollowStep(state, {
        scrollTop,
        scrollHeight: height,
        clientHeight: 400,
        now: 16 + i * 40 * MOTION_INSPECT_SCALE,
        pinned: true,
        reducedMotion: false,
        revealed: true,
      });
      maxFrameStep = Math.max(maxFrameStep, next.scrollTop - scrollTop);
      scrollTop = next.scrollTop;
      state = next.state;
      for (let j = 0; j < 48 * MOTION_INSPECT_SCALE; j += 1) {
        const ease = tipFollowStep(state, {
          scrollTop,
          scrollHeight: height,
          clientHeight: 400,
          now: 16 + i * 40 * MOTION_INSPECT_SCALE + (j + 1) * 16,
          pinned: true,
          reducedMotion: false,
          revealed: true,
        });
        maxFrameStep = Math.max(maxFrameStep, ease.scrollTop - scrollTop);
        scrollTop = ease.scrollTop;
        state = ease.state;
      }
    }
    expect(maxFrameStep).toBeLessThan(line);
    expect(maxFrameStep).toBeGreaterThan(0);
    expect(height - 400 - scrollTop).toBeLessThan(12 * MOTION_INSPECT_SCALE);
  });

  test("parks at debt≈0 and clears camera velocity", () => {
    let state = createTipFollowState();
    state = tipFollowNoteGrowth(state, 2000, 0);
    state = tipFollowNoteGrowth(state, 2024, 100);
    state = { ...state, scrollVelocity: 40 };
    const atTip = tipFollowStep(state, {
      scrollTop: 1624,
      scrollHeight: 2024,
      clientHeight: 400,
      now: 100,
      pinned: true,
      reducedMotion: false,
      revealed: true,
    });
    expect(atTip.state.running).toBe(false);
    expect(atTip.state.scrollVelocity).toBe(0);
    expect(atTip.state.hotUntil).toBe(100 + TIP_FOLLOW_HOT_IDLE_MS);
  });

  test("reduced motion and unrevealed snap to the tip", () => {
    let state = createTipFollowState();
    state = tipFollowNoteGrowth(state, 2400, 0);
    const reduced = tipFollowStep(state, {
      scrollTop: 900,
      scrollHeight: 2400,
      clientHeight: 400,
      now: 20,
      pinned: true,
      reducedMotion: true,
      revealed: true,
    });
    expect(reduced.scrollTop).toBe(2000);
    expect(reduced.state.running).toBe(false);
    expect(reduced.state.scrollVelocity).toBe(0);

    const hidden = tipFollowStep(state, {
      scrollTop: 900,
      scrollHeight: 2400,
      clientHeight: 400,
      now: 20,
      pinned: true,
      reducedMotion: false,
      revealed: false,
    });
    expect(hidden.scrollTop).toBe(2000);
  });

  test("cold oversized debt snaps; hot oversized growth eases", () => {
    const tall = 2000 + TIP_FOLLOW_SNAP_PX + 80;
    const cold = {
      ...createTipFollowState(),
      lastHeight: tall,
      hotUntil: 0,
    };
    const coldSnap = tipFollowStep(cold, {
      scrollTop: 1600,
      scrollHeight: tall,
      clientHeight: 400,
      now: 10_000,
      pinned: true,
      reducedMotion: false,
      revealed: true,
    });
    expect(coldSnap.scrollTop).toBe(tall - 400);
    expect(coldSnap.state.running).toBe(false);

    let hot = createTipFollowState();
    hot = tipFollowNoteGrowth(hot, 2000, 0);
    const tracked = tipFollowStep(hot, {
      scrollTop: 1600,
      scrollHeight: tall,
      clientHeight: 400,
      now: 20,
      pinned: true,
      reducedMotion: false,
      revealed: true,
    });
    expect(tracked.scrollTop).toBeGreaterThan(1600);
    expect(tracked.scrollTop).toBeLessThan(tall - 400);
    expect(tracked.state.running).toBe(true);
  });

  test("cancel clears running and camera velocity", () => {
    let state = createTipFollowState();
    state = { ...state, running: true, lastTs: 12, scrollVelocity: 90 };
    state = tipFollowCancel(state);
    expect(state.running).toBe(false);
    expect(state.lastTs).toBe(0);
    expect(state.scrollVelocity).toBe(0);
  });

  test("unpinned leaves scrollTop alone and stops", () => {
    let state = createTipFollowState();
    state = tipFollowNoteGrowth(state, 2400, 0);
    state = { ...state, running: true, hotUntil: 500, scrollVelocity: 30 };
    const next = tipFollowStep(state, {
      scrollTop: 900,
      scrollHeight: 2400,
      clientHeight: 400,
      now: 100,
      pinned: false,
      reducedMotion: false,
      revealed: true,
    });
    expect(next.scrollTop).toBe(900);
    expect(next.state.running).toBe(false);
    expect(next.state.scrollVelocity).toBe(0);
  });
});
