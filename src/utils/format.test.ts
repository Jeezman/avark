import { describe, expect, it } from "vitest";
import { formatCacheTime, formatCountdown, formatQuoteTime } from "./format";

describe("formatQuoteTime", () => {
  it("treats large values as milliseconds and small as seconds", () => {
    const ts = 1_779_043_842; // seconds
    // Same instant either way — must format identically.
    expect(formatQuoteTime(ts)).toBe(formatQuoteTime(ts * 1000));
  });

  it("returns a clock-like string", () => {
    expect(formatQuoteTime(Date.now())).toMatch(/\d{1,2}.\d{2}/);
  });
});

describe("formatCacheTime", () => {
  it("shows 'Never' for null or zero", () => {
    expect(formatCacheTime(null)).toBe("Never");
    expect(formatCacheTime(0)).toBe("Never");
  });

  it("formats unix seconds into a locale date-time", () => {
    // Exact output is locale-dependent; assert it's a real formatted string.
    const out = formatCacheTime(1_779_043_842);
    expect(out).not.toBe("Never");
    expect(out).toMatch(/\d/);
  });
});

describe("formatCountdown", () => {
  it("shows 'any moment' at or below a minute", () => {
    expect(formatCountdown(0)).toBe("any moment");
    expect(formatCountdown(60)).toBe("any moment");
  });

  it("shows minutes only under an hour", () => {
    expect(formatCountdown(25 * 60)).toBe("25m");
  });

  it("shows hours and minutes, flooring", () => {
    expect(formatCountdown(3 * 3600 + 59 * 60 + 59)).toBe("3h 59m");
    // ~167h55m — the CSV countdown of a freshly-broadcast 7-day exit.
    expect(formatCountdown(167 * 3600 + 55 * 60)).toBe("167h 55m");
  });
});
