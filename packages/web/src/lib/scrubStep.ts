/** Live edge uses null; history uses sequence 0..maxSeq-1. */

export type ScrubSeq = number | null;

export function stepScrub(
  scrubSeq: ScrubSeq,
  maxSeq: number,
  direction: "prev" | "next",
): ScrubSeq {
  if (maxSeq <= 0) return null;

  if (direction === "prev") {
    if (scrubSeq === null) return maxSeq - 1;
    if (scrubSeq <= 0) return 0;
    return scrubSeq - 1;
  }

  if (scrubSeq === null) return null;
  if (scrubSeq >= maxSeq - 1) return null;
  return scrubSeq + 1;
}

export function canStepPrev(scrubSeq: ScrubSeq, maxSeq: number): boolean {
  if (maxSeq <= 0) return false;
  if (scrubSeq === null) return true;
  return scrubSeq > 0;
}

export function canStepNext(scrubSeq: ScrubSeq, maxSeq: number): boolean {
  if (maxSeq <= 0) return false;
  return scrubSeq !== null;
}
