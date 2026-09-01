/** Required release-qualification duration for the framework UI soak. */
export const FRAMEWORK_UI_SOAK_DEFAULT_DURATION_MILLISECONDS = 30 * 60_000;

/** Bun test timeout headroom for final assertions and browser cleanup. */
export const FRAMEWORK_UI_SOAK_TEST_HEADROOM_MILLISECONDS = 5 * 60_000;

/** Shard headroom for browser setup, parity tests, and soak teardown. */
export const FRAMEWORK_UI_SOAK_PROFILE_HEADROOM_MILLISECONDS = 10 * 60_000;

/** Native step-cap headroom beyond the profiler's own deadline. */
export const FRAMEWORK_UI_SOAK_STEP_HEADROOM_MILLISECONDS = 60_000;
