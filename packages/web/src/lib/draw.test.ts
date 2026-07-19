import { describe, expect, it } from "vitest";
import { COLORS } from "./draw";

describe("draw helpers", () => {
  it("exposes high-contrast palette", () => {
    expect(COLORS.length).toBeGreaterThan(3);
    expect(COLORS[0]).toMatch(/^#/);
  });
});
