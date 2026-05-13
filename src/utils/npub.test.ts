import { describe, expect, test } from "vitest";
import { npubToHex } from "./npub";

describe("npubToHex", () => {
  test("decodes a valid npub to 64-char hex", () => {
    const npub =
      "npub1xf0lcxmc9z2h2jnvqhfv5wec2kjuys0p7kynmprc9attmw9aklfqmtg346";
    const hex = npubToHex(npub);
    expect(hex).not.toBeNull();
    expect(hex).toHaveLength(64);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  test("returns null for a malformed npub", () => {
    expect(npubToHex("not-an-npub")).toBeNull();
  });

  test("returns null when the prefix is not 'npub'", () => {
    // Valid bech32 but wrong prefix (an nsec, which we must NOT accept).
    const nsec =
      "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
    expect(npubToHex(nsec)).toBeNull();
  });

  test("is deterministic — same npub maps to the same hex", () => {
    const npub =
      "npub1xf0lcxmc9z2h2jnvqhfv5wec2kjuys0p7kynmprc9attmw9aklfqmtg346";
    expect(npubToHex(npub)).toBe(npubToHex(npub));
  });
});
