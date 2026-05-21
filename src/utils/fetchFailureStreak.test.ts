import { describe, expect, test } from "vitest";
import {
  AUTO_FAILURES_BEFORE_TOAST,
  advanceFailureStreak,
} from "./fetchFailureStreak";

describe("advanceFailureStreak", () => {
  test("increments the streak on each failure", () => {
    expect(advanceFailureStreak(0).streak).toBe(1);
    expect(advanceFailureStreak(1).streak).toBe(2);
    expect(advanceFailureStreak(5).streak).toBe(6);
  });

  test("does not toast before the threshold", () => {
    expect(advanceFailureStreak(0).shouldToast).toBe(false);
    expect(
      advanceFailureStreak(AUTO_FAILURES_BEFORE_TOAST - 2).shouldToast,
    ).toBe(false);
  });

  test("toasts exactly when the streak first reaches the threshold", () => {
    const { streak, shouldToast } = advanceFailureStreak(
      AUTO_FAILURES_BEFORE_TOAST - 1,
    );
    expect(streak).toBe(AUTO_FAILURES_BEFORE_TOAST);
    expect(shouldToast).toBe(true);
  });

  test("does not toast again past the threshold — one toast per outage", () => {
    expect(
      advanceFailureStreak(AUTO_FAILURES_BEFORE_TOAST).shouldToast,
    ).toBe(false);
    expect(
      advanceFailureStreak(AUTO_FAILURES_BEFORE_TOAST + 10).shouldToast,
    ).toBe(false);
  });
});
