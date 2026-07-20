import { describe, expect, it } from "vitest";
import { canStepNext, canStepPrev, stepScrub } from "./scrubStep";

describe("stepScrub", () => {
  it("returns null when there is no history", () => {
    expect(stepScrub(null, 0, "prev")).toBe(null);
    expect(stepScrub(null, 0, "next")).toBe(null);
    expect(stepScrub(0, 0, "prev")).toBe(null);
  });

  it("steps from live into history at max-1", () => {
    expect(stepScrub(null, 5, "prev")).toBe(4);
    expect(stepScrub(null, 1, "prev")).toBe(0);
  });

  it("steps backward within history and clamps at 0", () => {
    expect(stepScrub(3, 5, "prev")).toBe(2);
    expect(stepScrub(0, 5, "prev")).toBe(0);
  });

  it("steps forward and returns to live from max-1", () => {
    expect(stepScrub(2, 5, "next")).toBe(3);
    expect(stepScrub(4, 5, "next")).toBe(null);
    expect(stepScrub(0, 1, "next")).toBe(null);
  });

  it("next from live stays live", () => {
    expect(stepScrub(null, 5, "next")).toBe(null);
  });
});

describe("canStepPrev / canStepNext", () => {
  it("disables both with no history", () => {
    expect(canStepPrev(null, 0)).toBe(false);
    expect(canStepNext(null, 0)).toBe(false);
  });

  it("allows prev from live and next only while historical", () => {
    expect(canStepPrev(null, 3)).toBe(true);
    expect(canStepNext(null, 3)).toBe(false);
    expect(canStepPrev(1, 3)).toBe(true);
    expect(canStepNext(1, 3)).toBe(true);
  });

  it("disables prev at sequence 0", () => {
    expect(canStepPrev(0, 3)).toBe(false);
    expect(canStepNext(0, 3)).toBe(true);
  });
});
