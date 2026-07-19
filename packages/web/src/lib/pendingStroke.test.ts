import { describe, expect, it } from "vitest";
import { retainUnconfirmedStrokes, type PendingLocalStroke } from "./pendingStroke";
import type { BoardSnapshot } from "./types";

const local: PendingLocalStroke = {
  id: "stroke-local",
  color: "#111111",
  width: 4,
  tool: "pen",
  points: [
    { x: 10, y: 10, p: 0.5 },
    { x: 20, y: 20, p: 0.5 },
  ],
};

function snapshot(strokeIds: string[]): BoardSnapshot {
  return {
    strokes: strokeIds.map((id) => ({
      id,
      sender_id: "self",
      color: "#111111",
      width: 4,
      tool: "pen",
      points: local.points,
      erased: false,
      seq_begin: 1,
      seq_end: 3,
    })),
    undo_stack: [],
    redo_stack: [],
    last_seq: strokeIds.length ? 3 : 1,
  };
}

describe("retainUnconfirmedStrokes", () => {
  it("keeps a local stroke through begin-only snapshots", () => {
    expect(retainUnconfirmedStrokes([local], snapshot([]))).toEqual([local]);
  });

  it("retires a local stroke after its completed snapshot arrives", () => {
    expect(retainUnconfirmedStrokes([local], snapshot([local.id]))).toEqual([]);
  });

  it("does not retire a local stroke when another stroke is confirmed", () => {
    expect(retainUnconfirmedStrokes([local], snapshot(["other-stroke"]))).toEqual([
      local,
    ]);
  });
});
