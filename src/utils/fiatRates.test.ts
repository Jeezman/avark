import { describe, expect, test } from "vitest";
import { formatFiat } from "./fiatRates";

const SATS_PER_BTC = 100_000_000;

describe("formatFiat", () => {
  describe("default (2-decimal) currencies", () => {
    test("USD renders with 2 decimals and en-US separators", () => {
      // 1 BTC @ $67,432.18 → $67,432.18
      expect(formatFiat(SATS_PER_BTC, 67_432.18, "USD")).toBe("$67,432.18");
    });

    test("EUR renders with 2 decimals", () => {
      expect(formatFiat(SATS_PER_BTC, 50_000, "EUR")).toMatch(/^€50,000\.00$/);
    });

    test("GBP renders with 2 decimals", () => {
      expect(formatFiat(SATS_PER_BTC, 48_000, "GBP")).toBe("£48,000.00");
    });
  });

  describe("zero-decimal currencies (ZERO_DECIMAL_CODES)", () => {
    test("JPY renders with no fractional part", () => {
      // 0.5 BTC @ ¥10,000,000/BTC → ¥5,000,000
      expect(formatFiat(SATS_PER_BTC / 2, 10_000_000, "JPY")).toBe("¥5,000,000");
    });

    test.each(["JPY", "KRW", "CLP", "ISK", "BIF", "DJF", "GNF"])(
      "%s renders without a decimal point",
      (code) => {
        const formatted = formatFiat(SATS_PER_BTC / 2, 10_000_000, code);
        expect(formatted).not.toContain(".");
      },
    );
  });

  describe("three-decimal currencies (THREE_DECIMAL_CODES)", () => {
    test.each(["BHD", "JOD"])("%s renders with exactly 3 decimal places", (code) => {
      // 1 BTC @ 25,000 → 25,000.000
      const formatted = formatFiat(SATS_PER_BTC, 25_000, code);
      expect(formatted).toMatch(/\.\d{3}$/);
      expect(formatted).not.toMatch(/\.\d{4}/);
    });
  });

  describe("en-US locale pinning", () => {
    test("decimal separator is '.' regardless of system locale", () => {
      // Key regression guard: system locales like de-DE would render "35,64"
      expect(formatFiat(SATS_PER_BTC / 1000, 35_640, "USD")).toContain(".");
      expect(formatFiat(SATS_PER_BTC / 1000, 35_640, "USD")).not.toMatch(/\$\d+,\d{2}$/);
    });

    test("thousands separator is ',' for large amounts", () => {
      expect(formatFiat(SATS_PER_BTC, 1_234_567.89, "USD")).toBe("$1,234,567.89");
    });
  });

  describe("conversion math", () => {
    test("1 BTC at $X/BTC renders as $X", () => {
      expect(formatFiat(SATS_PER_BTC, 67_000, "USD")).toBe("$67,000.00");
    });

    test("1 sat at $100M/BTC renders as $1.00", () => {
      expect(formatFiat(1, 100_000_000, "USD")).toBe("$1.00");
    });

    test("zero sats renders as zero", () => {
      expect(formatFiat(0, 67_000, "USD")).toBe("$0.00");
    });
  });
});
