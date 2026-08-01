/* ----------------------------------------------------------------------------
   Tip-follow camera (pure)

   DOM truth is immediate; the camera eases down toward the layout tip.
   No React, no DOM — the shell reads metrics, calls step, writes scrollTop.

   One law while pinned — second-order camera (no hard first bite):

     desiredVel = debt / τ
     scrollVel  → exponential approach to desiredVel (accel τ = k·τ)
     scrollTop += scrollVel · dt   (clamp: no overshoot past tip)

   - Debt jumps with layout; velocity cannot — so motion eases in, then as
     debt falls desiredVel→0 and velocity eases out (soft settle).
   - τ still adapts (calm / catch-up / line / idle settle).
   - maxStep is a speed ceiling only, never a one-frame glue.
   - Shrink is separate: compensate Δh so collapse doesn't fight the ease
   - Snap only for first paint / reduced motion / cold oversized jumps
   -------------------------------------------------------------------------- */

import { MOTION_INSPECT_SCALE } from "../lib/motion-inspect";

const _t = (ms: number) => ms * MOTION_INSPECT_SCALE;
const _s = (pxPerSec: number) => pxPerSec / MOTION_INSPECT_SCALE;

/** Calm ease while live: remaining debt shrinks ~63% every τ_max ms. */
export const TIP_FOLLOW_TAU_MAX_MS = _t(720);
/** Catch-up ease under large tip-debt (reader far behind / big paste). */
export const TIP_FOLLOW_TAU_MIN_MS = _t(200);
/**
 * Idle settle τ — stream quiet, soft landing into the tip. Longer than live
 * calm so the last pixels decelerate instead of linear-crawling then stopping.
 */
export const TIP_FOLLOW_SETTLE_TAU_MS = _t(960);
/** Debt that saturates urgency toward τ_min. */
export const TIP_FOLLOW_CATCHUP_DEBT_PX = 240;
/** Keep the rAF alive this long after the last height growth. */
export const TIP_FOLLOW_HOT_IDLE_MS = _t(320);
/** Cold oversized debt snaps (session switch / huge fold), not eases. */
export const TIP_FOLLOW_SNAP_PX = 480;
/** Soft speed floor while live with tiny debt (px/s). */
export const TIP_FOLLOW_CALM_MAX_PX_S = _s(42);
/** Soft speed ceiling while catching a fast stream / modest tip-debt (px/s). */
export const TIP_FOLLOW_BURST_MAX_PX_S = _s(420);
/** Ceiling for huge tip-debt / large single-frame walls (px/s). */
export const TIP_FOLLOW_SURGE_MAX_PX_S = _s(1800);
/**
 * @deprecated Position growth-track removed — camera is velocity-smoothed.
 * Kept so older tests/imports do not break.
 */
export const TIP_FOLLOW_GROWTH_TRACK = 0;
/** @deprecated */
export const TIP_FOLLOW_LINE_TRACK = 0;
/** @deprecated Sub-line special-case removed with growth-track. */
export const TIP_FOLLOW_TOKEN_GROWTH_PX = 10;
/** Hot line-sized tip-debt uses the short {@link TIP_FOLLOW_LINE_TAU_MS}. */
export const TIP_FOLLOW_LINE_GROWTH_PX = 48;
/** Hot τ ceiling while closing a line-sized tip-debt (ms). */
export const TIP_FOLLOW_LINE_TAU_MS = _t(140);
/**
 * Velocity ease-in/out: scrollVel approaches desiredVel with this fraction of τ.
 * Lower → snappier accel; higher → softer start (and slower reaction).
 */
export const TIP_FOLLOW_ACCEL_TAU_FRAC = 0.45;
/** @deprecated Soft-rise FLIP removed — line glue was the bug. */
export const TIP_FOLLOW_SOFT_RISE_MS = 0;
/** @deprecated */
export const TIP_FOLLOW_SOFT_RISE_MAX_PX = 96;
/** @deprecated */
export const TIP_FOLLOW_SOFT_RISE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
/** Ignore sub-pixel / reflow height noise for shrink compensate. */
export const TIP_FOLLOW_SHRINK_EPS_PX = 4;
/** Growth speed (px/s) that saturates velocity urgency. */
export const TIP_FOLLOW_VELOCITY_REF_PX_S = _s(420);
/**
 * Tip-debt below which growth velocity must not tighten τ.
 * Sparse tokens are high-velocity by nature; only arm once actually behind.
 */
export const TIP_FOLLOW_VELOCITY_ARM_DEBT_PX = 72;
/** EMA decay τ for growthVelocity when height is flat (ms). */
export const TIP_FOLLOW_VELOCITY_DECAY_MS = _t(180);
/** Reader-up pixels above clamp budget that count as leaving the tip. */
export const TIP_FOLLOW_READER_UP_EPS_PX = 2;
/** @deprecated Shrink lock removed; kept so old imports do not break. */
export const TIP_FOLLOW_SHRINK_LOCK_MS = 0;
/** @deprecated Absorb thresholds removed — growth track is continuous. */
export const TIP_FOLLOW_GROWTH_ABSORB_PX = 96;

/**
 * ScrollTop decrease not explained by a maxScroll clamp (fold / composer
 * shrink). Fold clamp: top falls by ≈ maxScroll fall → 0. Real scroll-up:
 * top falls while maxScroll holds → positive. No timers.
 */
export function readerScrollUpPx(
  prevTop: number,
  nextTop: number,
  prevMaxScroll: number,
  nextMaxScroll: number,
): number {
  const topDelta = prevTop - nextTop;
  const clampBudget = Math.max(0, prevMaxScroll - nextMaxScroll);
  return topDelta - clampBudget;
}

export type TipFollowState = {
  running: boolean;
  hotUntil: number;
  lastTs: number;
  lastHeight: number;
  lastGrowthAt: number;
  /** EMA of recent height growth (px/s); nudges τ / ceiling under bursts. */
  growthVelocity: number;
  /** Camera velocity toward tip (px/s). Smoothed — never jumps with debt. */
  scrollVelocity: number;
};

export type TipFollowStepInput = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  now: number;
  pinned: boolean;
  reducedMotion: boolean;
  revealed: boolean;
};

export type TipFollowStepResult = {
  scrollTop: number;
  state: TipFollowState;
};

export function createTipFollowState(): TipFollowState {
  return {
    running: false,
    hotUntil: 0,
    lastTs: 0,
    lastHeight: 0,
    lastGrowthAt: 0,
    growthVelocity: 0,
    scrollVelocity: 0,
  };
}

export function tipFollowCancel(state: TipFollowState): TipFollowState {
  return {
    ...state,
    running: false,
    lastTs: 0,
    scrollVelocity: 0,
  };
}

/**
 * Record content height. Positive growth extends the hot window so sparse
 * lines do not tear down the follow loop between appends.
 */
export function tipFollowNoteGrowth(
  state: TipFollowState,
  height: number,
  now: number,
): TipFollowState {
  const previous = state.lastHeight;
  if (previous <= 0) {
    return { ...state, lastHeight: height };
  }
  if (height <= previous) {
    return { ...state, lastHeight: height };
  }
  const dt = state.lastGrowthAt > 0 ? now - state.lastGrowthAt : 0;
  let growthVelocity = state.growthVelocity;
  if (dt > 0) {
    const instant = ((height - previous) / dt) * 1000;
    growthVelocity = growthVelocity * 0.65 + instant * 0.35;
  }
  return {
    ...state,
    lastHeight: height,
    lastGrowthAt: now,
    growthVelocity,
    hotUntil: now + TIP_FOLLOW_HOT_IDLE_MS,
  };
}

/**
 * Adaptive τ: small debt → calm; large debt / armed velocity → catch-up.
 * While hot, floor urgency so live streams are not stuck on calm τ.
 * Idle settle uses the longer settle τ.
 */
export function tipFollowTauMs(
  debtPx: number,
  growthVelocityPxPerSec = 0,
  settling = false,
  hot = false,
): number {
  if (settling) {
    return TIP_FOLLOW_SETTLE_TAU_MS;
  }
  const absDebt = Math.abs(debtPx);
  const debtT = Math.min(1, absDebt / TIP_FOLLOW_CATCHUP_DEBT_PX);
  let velUrgency = 0;
  if (absDebt >= TIP_FOLLOW_VELOCITY_ARM_DEBT_PX) {
    const velT = Math.min(1, Math.max(0, growthVelocityPxPerSec) / TIP_FOLLOW_VELOCITY_REF_PX_S);
    velUrgency = velT * 0.55;
  }
  const hotUrgency = hot ? 0.65 : 0;
  const urgency = Math.min(1, Math.max(debtT, velUrgency, hotUrgency));
  let tau = TIP_FOLLOW_TAU_MAX_MS + (TIP_FOLLOW_TAU_MIN_MS - TIP_FOLLOW_TAU_MAX_MS) * urgency;
  // Line-sized live debt: close over ~LINE_TAU so the glide finishes before
  // the next newline without needing 1:1 tip-glue.
  if (hot && absDebt > 0 && absDebt <= TIP_FOLLOW_LINE_GROWTH_PX) {
    tau = Math.min(tau, TIP_FOLLOW_LINE_TAU_MS);
  }
  return tau;
}

/**
 * Soft speed ceiling from continuous signals (debt, velocity EMA, this-frame
 * growth). No mode switches — larger inputs raise the ceiling smoothly.
 */
export function tipFollowMaxStepPx(
  debtPx: number,
  growthVelocityPxPerSec: number,
  dtMs: number,
  frameGrowthPx = 0,
  hot = false,
): number {
  const absDebt = Math.abs(debtPx);
  const debtT = Math.min(1, absDebt / TIP_FOLLOW_CATCHUP_DEBT_PX);
  const velT = Math.min(1, Math.max(0, growthVelocityPxPerSec) / TIP_FOLLOW_VELOCITY_REF_PX_S);
  const armed = absDebt >= TIP_FOLLOW_VELOCITY_ARM_DEBT_PX;
  const blend = Math.max(debtT, armed ? velT : 0, hot ? 0.35 : 0);
  let maxPxS =
    TIP_FOLLOW_CALM_MAX_PX_S +
    (TIP_FOLLOW_BURST_MAX_PX_S - TIP_FOLLOW_CALM_MAX_PX_S) * blend * blend;
  if (hot && frameGrowthPx > 0 && dtMs > 0) {
    // Allow tracking this frame's growth rate (growthTrack uses a fraction).
    maxPxS = Math.max(maxPxS, (frameGrowthPx / dtMs) * 1000);
  }
  if (hot && growthVelocityPxPerSec > TIP_FOLLOW_CALM_MAX_PX_S) {
    // Live stream: slightly outrun the EMA so tip-debt cannot ratchet forever.
    maxPxS = Math.max(maxPxS, Math.min(TIP_FOLLOW_BURST_MAX_PX_S, growthVelocityPxPerSec * 1.25));
  }
  if (hot && absDebt > 8) {
    // Continuous debt horizon (no catch-up cliff at CATCHUP_DEBT).
    maxPxS = Math.max(maxPxS, Math.min(TIP_FOLLOW_SURGE_MAX_PX_S, absDebt / 0.2));
  } else if (absDebt >= TIP_FOLLOW_CATCHUP_DEBT_PX) {
    maxPxS = Math.max(maxPxS, Math.min(TIP_FOLLOW_SURGE_MAX_PX_S, absDebt / 0.12));
  }
  return (maxPxS / 1000) * dtMs;
}

function targetScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

/**
 * Counter-offset for soft-rise after tip-glue: start from the mid-flight
 * translateY (if any) plus this frame's glued scroll delta, capped.
 * Shell applies translateY(from) → 0 over {@link TIP_FOLLOW_SOFT_RISE_MS}.
 */
export function tipFollowSoftRiseFrom(
  currentTranslateY: number,
  gluedScrollDelta: number,
  maxPx: number = TIP_FOLLOW_SOFT_RISE_MAX_PX,
): number {
  const stacked = Math.max(0, currentTranslateY) + Math.max(0, gluedScrollDelta);
  return Math.min(maxPx, stacked);
}

/** Read live translateY from a transformed content column (mid soft-rise). */
export function readTranslateY(el: HTMLElement): number {
  const raw = getComputedStyle(el).transform;
  if (!raw || raw === "none") {
    return 0;
  }
  try {
    return new DOMMatrixReadOnly(raw).m42;
  } catch {
    return 0;
  }
}

/**
 * Cancel the tip-glue pop: start at translateY(+δ) and ease to 0.
 * Uses WAAPI — a same-frame CSS transition never paints the counter-offset,
 * so the scroll jump stays an instant one-line pop.
 */
export function tipFollowPlaySoftRise(
  el: HTMLElement,
  gluedScrollDelta: number,
  opts?: {
    durationMs?: number;
    maxPx?: number;
    easing?: string;
  },
): void {
  if (gluedScrollDelta <= 0.5) {
    return;
  }
  const durationMs = opts?.durationMs ?? TIP_FOLLOW_SOFT_RISE_MS;
  const maxPx = opts?.maxPx ?? TIP_FOLLOW_SOFT_RISE_MAX_PX;
  const easing = opts?.easing ?? TIP_FOLLOW_SOFT_RISE_EASING;
  const from = tipFollowSoftRiseFrom(readTranslateY(el), gluedScrollDelta, maxPx);
  if (from <= 0.5) {
    return;
  }
  // Drop any in-flight rise / leftover CSS transition before starting clean.
  if (typeof el.getAnimations === "function") {
    for (const animation of el.getAnimations()) {
      animation.cancel();
    }
  }
  el.style.transition = "";
  // Hold the counter-offset in style until WAAPI’s first keyframe applies.
  // Clearing to "" here painted one frame of hard tip-glue (the pop).
  el.style.transform = `translateY(${from}px)`;
  if (typeof el.animate !== "function") {
    return;
  }
  const animation = el.animate(
    [{ transform: `translateY(${from}px)` }, { transform: "translateY(0px)" }],
    // `backwards`: first keyframe applies immediately (no gap after cancel).
    { duration: durationMs, easing, fill: "backwards" },
  );
  const clearHold = () => {
    if (el.style.transform === `translateY(${from}px)`) {
      el.style.transform = "";
    }
  };
  animation.addEventListener("finish", clearHold, { once: true });
  animation.addEventListener("cancel", clearHold, { once: true });
}

/** Stop soft-rise and clear any CSS transform residue. */
export function tipFollowClearSoftRise(el: HTMLElement): void {
  if (typeof el.getAnimations === "function") {
    for (const animation of el.getAnimations()) {
      animation.cancel();
    }
  }
  el.style.transition = "";
  el.style.transform = "";
}

/**
 * Height left the document (settle collapse / composer). Keep the same pixels
 * on screen: scrollTop -= Δh, clamped to the new max.
 */
export function tipFollowCompensateShrink(
  scrollTop: number,
  previousHeight: number,
  nextHeight: number,
  clientHeight: number,
  epsPx: number = TIP_FOLLOW_SHRINK_EPS_PX,
): number {
  const delta = previousHeight - nextHeight;
  if (delta <= epsPx) {
    return scrollTop;
  }
  const maxScroll = Math.max(0, nextHeight - clientHeight);
  return Math.max(0, Math.min(maxScroll, scrollTop - delta));
}

/**
 * One camera step. Shell schedules the next rAF while `result.state.running`.
 */
export function tipFollowStep(
  state: TipFollowState,
  input: TipFollowStepInput,
): TipFollowStepResult {
  const { scrollTop, scrollHeight, clientHeight, now, pinned, reducedMotion, revealed } = input;
  const previousHeight = state.lastHeight;
  const frameGrowth =
    previousHeight > 0 && scrollHeight > previousHeight ? scrollHeight - previousHeight : 0;
  const grew = frameGrowth > 0;
  let noted = tipFollowNoteGrowth(state, scrollHeight, now);
  const target = targetScrollTop(scrollHeight, clientHeight);
  const debt = target - scrollTop;
  const hot = now < noted.hotUntil;
  const settling = !hot && Math.abs(debt) < TIP_FOLLOW_CATCHUP_DEBT_PX;

  if (!pinned) {
    return {
      scrollTop,
      state: tipFollowCancel(noted),
    };
  }

  if (!revealed || reducedMotion) {
    return {
      scrollTop: target,
      state: tipFollowCancel(noted),
    };
  }

  if (Math.abs(debt) > TIP_FOLLOW_SNAP_PX && !hot) {
    return {
      scrollTop: target,
      state: tipFollowCancel(noted),
    };
  }

  const dt = noted.lastTs === 0 ? 16 : Math.min(64, Math.max(8, now - noted.lastTs));
  if (!grew && noted.growthVelocity > 0) {
    const decayed = noted.growthVelocity * Math.exp(-dt / TIP_FOLLOW_VELOCITY_DECAY_MS);
    noted = {
      ...noted,
      growthVelocity: decayed < 1 ? 0 : decayed,
    };
  }

  if (Math.abs(debt) <= 0.75) {
    return {
      scrollTop: Math.abs(debt) > 0 ? target : scrollTop,
      state: {
        ...tipFollowCancel(noted),
        growthVelocity: hot ? noted.growthVelocity : 0,
      },
    };
  }

  const tau = tipFollowTauMs(debt, noted.growthVelocity, settling, hot);
  const dtSec = dt / 1000;
  const tauSec = Math.max(tau / 1000, 1e-3);
  // P-gain: held desiredVel would close debt in ~τ. Velocity cannot jump —
  // it eases toward desiredVel, so a new line accelerates in then settles out.
  const desiredVel = debt / tauSec;
  const accelTauSec = Math.max(tauSec * TIP_FOLLOW_ACCEL_TAU_FRAC, 0.02);
  const velAlpha = 1 - Math.exp(-dtSec / accelTauSec);
  let scrollVelocity =
    (noted.scrollVelocity ?? 0) + (desiredVel - (noted.scrollVelocity ?? 0)) * velAlpha;

  const maxStep = tipFollowMaxStepPx(debt, noted.growthVelocity, dt, frameGrowth, hot);
  const maxVel = maxStep / dtSec;
  if (Math.abs(scrollVelocity) > maxVel) {
    scrollVelocity = Math.sign(scrollVelocity) * maxVel;
  }

  let next = scrollTop + scrollVelocity * dtSec;
  // Never overshoot the tip — stop and kill velocity on arrival.
  if (debt > 0 && next >= target - 0.35) {
    next = target;
    scrollVelocity = 0;
  } else if (debt < 0 && next <= target + 0.35) {
    next = target;
    scrollVelocity = 0;
  }
  next = Math.max(0, next);

  return {
    scrollTop: next,
    state: {
      ...noted,
      scrollVelocity,
      running: Math.abs(target - next) > 0.35 || Math.abs(scrollVelocity) > 1,
      lastTs: now,
    },
  };
}
