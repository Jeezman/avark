import { describe, expect, it } from "vitest";
import { parseSatAmount } from "./amount";

describe("parseSatAmount", () => {
  it("parses plain digit strings", () => {
    expect(parseSatAmount("2610")).toBe(2610);
    expect(parseSatAmount(" 500 ")).toBe(500);
  });

  it("rejects zero and empty", () => {
    expect(parseSatAmount("0")).toBeNull();
    expect(parseSatAmount("")).toBeNull();
  });

  it("rejects non-digit grammars the old Number() parse accepted", () => {
    expect(parseSatAmount("1e3")).toBeNull();
    expect(parseSatAmount("0x10")).toBeNull();
    expect(parseSatAmount("+500")).toBeNull();
    expect(parseSatAmount("-500")).toBeNull();
    expect(parseSatAmount("1.5")).toBeNull();
    expect(parseSatAmount("100abc")).toBeNull();
  });

  it("rejects values that lose float precision", () => {
    // 21 digits — regex passes, but Number() would round it.
    expect(parseSatAmount("999999999999999999999")).toBeNull();
    expect(parseSatAmount(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});
