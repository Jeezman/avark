import { describe, expect, it } from "vitest";
import {
  maxSweepSat,
  poolBelowDust,
  sweepAmountError,
  SWEEP_FEE_BUFFER_SATS,
} from "./sweepAmount";

const DUST = 330;

describe("maxSweepSat", () => {
  it("subtracts the fee buffer", () => {
    expect(maxSweepSat(5029)).toBe(5029 - SWEEP_FEE_BUFFER_SATS);
  });

  it("floors at zero when the pool can't cover the fee", () => {
    expect(maxSweepSat(500)).toBe(0);
  });
});

describe("poolBelowDust", () => {
  // The bug report case: a lone 1,289-sat VTXO leaves 289 after the fee,
  // below the 330-sat dust limit — unsweepable on its own.
  it("flags a pool whose max is below dust", () => {
    expect(poolBelowDust(1289, DUST)).toBe(true);
  });

  it("accepts a pool whose max meets dust", () => {
    expect(poolBelowDust(1330, DUST)).toBe(false);
    expect(poolBelowDust(5029, DUST)).toBe(false);
  });
});

describe("sweepAmountError", () => {
  it("rejects non-positive, fractional, and non-numeric amounts", () => {
    expect(sweepAmountError(0, 5029, DUST)).toEqual({ kind: "invalid" });
    expect(sweepAmountError(-5, 5029, DUST)).toEqual({ kind: "invalid" });
    expect(sweepAmountError(12.5, 5029, DUST)).toEqual({ kind: "invalid" });
    expect(sweepAmountError(NaN, 5029, DUST)).toEqual({ kind: "invalid" });
  });

  it("rejects amounts below the dust limit", () => {
    expect(sweepAmountError(289, 5029, DUST)).toEqual({
      kind: "belowDust",
      dustSat: DUST,
    });
    expect(sweepAmountError(DUST - 1, 5029, DUST)).toEqual({
      kind: "belowDust",
      dustSat: DUST,
    });
  });

  it("rejects amounts the pool can't cover after the fee", () => {
    expect(sweepAmountError(4030, 5029, DUST)).toEqual({
      kind: "exceedsMax",
      maxSat: 4029,
    });
  });

  it("accepts dust-or-above amounts up to the max", () => {
    expect(sweepAmountError(DUST, 5029, DUST)).toBeNull();
    expect(sweepAmountError(4029, 5029, DUST)).toBeNull();
  });
});
