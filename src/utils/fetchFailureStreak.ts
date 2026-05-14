/**
 * Consecutive failed auto-refresh polls before a "couldn't refresh" toast.
 *
 * A single failed poll is almost always transient — the device went to sleep
 * and the OS suspended the network, so one poll fails and the next recovers.
 * Surfacing a toast for that is noise. A sustained outage produces many
 * consecutive failures and still gets reported.
 */
export const AUTO_FAILURES_BEFORE_TOAST = 3;

/**
 * Advance the consecutive-auto-failure streak after a failed poll and decide
 * whether this failure should surface a toast.
 *
 * The toast fires exactly once — when the streak first *reaches* the
 * threshold — not on every subsequent failure, so one outage produces one
 * toast. A clean poll resets the streak; that reset is the caller's job.
 */
export function advanceFailureStreak(current: number): {
  streak: number;
  shouldToast: boolean;
} {
  const streak = current + 1;
  return { streak, shouldToast: streak === AUTO_FAILURES_BEFORE_TOAST };
}
