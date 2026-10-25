// A shake is a few strong jolts in quick succession, not one bump or a phone put down hard.
export const SHAKE_THRESHOLD_G = 2.3;
export const SHAKE_JOLTS = 3;
export const SHAKE_WINDOW_MS = 900;
export const SHAKE_COOLDOWN_MS = 3000;

export type Acceleration = Readonly<{ x: number; y: number; z: number }>;

/** Feed accelerometer samples (in g) with their time; calls `onShake` once per shake. */
export function createShakeDetector(onShake: () => void) {
  let jolts: number[] = [];
  let quietUntil = 0;
  return (sample: Acceleration, at: number) => {
    if (at < quietUntil) return;
    const force = Math.sqrt(sample.x ** 2 + sample.y ** 2 + sample.z ** 2);
    if (force < SHAKE_THRESHOLD_G) return;
    jolts = [...jolts.filter((time) => at - time <= SHAKE_WINDOW_MS), at];
    if (jolts.length < SHAKE_JOLTS) return;
    jolts = [];
    quietUntil = at + SHAKE_COOLDOWN_MS;
    onShake();
  };
}
