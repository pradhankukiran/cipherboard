import { describe, expect, it } from "vitest";
import { COLORS, paintSnapshot } from "./draw";
import type { BoardSnapshot } from "./types";

describe("draw helpers", () => {
  it("exposes high-contrast palette", () => {
    expect(COLORS.length).toBeGreaterThan(3);
    expect(COLORS[0]).toMatch(/^#/);
  });

  it("paints confirmed points with the caller's high-DPI transform", () => {
    let transform = 2;
    const transforms: number[] = [];
    const clears: Array<[number, number]> = [];
    const stack: number[] = [];
    const ctx = {
      canvas: { width: 800, height: 600 },
      save: () => stack.push(transform),
      restore: () => {
        transform = stack.pop()!;
      },
      setTransform: (a: number) => {
        transform = a;
      },
      clearRect: (_x: number, _y: number, width: number, height: number) =>
        clears.push([width, height]),
      fillRect: () => undefined,
      beginPath: () => undefined,
      moveTo: () => transforms.push(transform),
      lineTo: () => transforms.push(transform),
      stroke: () => undefined,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      globalCompositeOperation: "source-over",
    } as unknown as CanvasRenderingContext2D;
    const snapshot: BoardSnapshot = {
      strokes: [
        {
          id: "stroke-1",
          sender_id: "admin",
          color: "#111111",
          width: 3,
          tool: "pen",
          points: [
            { x: 100, y: 80, p: 0.5 },
            { x: 160, y: 120, p: 0.5 },
          ],
          erased: false,
          seq_begin: 1,
          seq_end: 3,
        },
      ],
      undo_stack: ["stroke-1"],
      redo_stack: [],
      last_seq: 3,
    };

    paintSnapshot(ctx, snapshot, 400, 300);

    expect(clears).toEqual([[800, 600]]);
    expect(transforms).toEqual([2, 2]);
  });
});
