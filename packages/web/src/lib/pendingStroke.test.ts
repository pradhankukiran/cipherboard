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

  it("keeps a local stroke when replay flushes a begin-only ack with the same id", () => {
    const beginOnlyAck: BoardSnapshot = {
      strokes: [
        {
          id: local.id,
          sender_id: "self",
          color: local.color,
          width: local.width,
          tool: local.tool,
          points: [],
          erased: false,
          seq_begin: 1,
          seq_end: 1,
        },
      ],
      undo_stack: [],
      redo_stack: [],
      last_seq: 1,
    };
    expect(retainUnconfirmedStrokes([local], beginOnlyAck)).toEqual([local]);
  });

  it("keeps a local stroke when same-id ack has only a partial point prefix", () => {
    const partialAck: BoardSnapshot = {
      strokes: [
        {
          id: local.id,
          sender_id: "self",
          color: local.color,
          width: local.width,
          tool: local.tool,
          points: [local.points[0]!],
          erased: false,
          seq_begin: 1,
          seq_end: 2,
        },
      ],
      undo_stack: [],
      redo_stack: [],
      last_seq: 2,
    };
    expect(retainUnconfirmedStrokes([local], partialAck)).toEqual([local]);
  });

  it("keeps a local stroke when a partial prefix revisits the final coordinate earlier", () => {
    const loopingLocal: PendingLocalStroke = {
      ...local,
      points: [
        { x: 10, y: 10, p: 0.5 },
        { x: 30, y: 30, p: 0.5 },
        { x: 10, y: 10, p: 0.5 },
      ],
    };
    const partialLoopAck: BoardSnapshot = {
      strokes: [
        {
          id: loopingLocal.id,
          sender_id: "self",
          color: loopingLocal.color,
          width: loopingLocal.width,
          tool: loopingLocal.tool,
          points: [
            { x: 10, y: 10, p: 0.5 },
            { x: 30, y: 30, p: 0.5 },
          ],
          erased: false,
          seq_begin: 1,
          seq_end: 2,
        },
      ],
      undo_stack: [],
      redo_stack: [],
      last_seq: 2,
    };
    expect(retainUnconfirmedStrokes([loopingLocal], partialLoopAck)).toEqual([
      loopingLocal,
    ]);
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
