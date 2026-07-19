import type { BoardSnapshot, Point, StrokeRecord } from "./types";

export function paintSnapshot(
  ctx: CanvasRenderingContext2D,
  snap: BoardSnapshot,
  width: number,
  height: number,
): void {
  // Clear in backing-store pixels, then restore the caller's CSS-to-device
  // transform before painting. Snapshot points use CSS pixel coordinates just
  // like live pointer points; drawing them under the identity transform moves
  // confirmed strokes on high-DPI displays.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  for (const stroke of snap.strokes) {
    if (stroke.erased) continue;
    drawStroke(ctx, stroke);
  }
  ctx.restore();
}

export function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: StrokeRecord,
): void {
  if (stroke.points.length === 0) return;
  ctx.save();
  if (stroke.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0,0,0,1)";
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.color;
  }
  ctx.lineWidth = stroke.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  const pts = stroke.points;
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i]!.x, pts[i]!.y);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawLiveStroke(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  width: number,
  tool: string,
): void {
  drawStroke(ctx, {
    id: "live",
    sender_id: "",
    color,
    width,
    tool,
    points,
    erased: false,
    seq_begin: 0,
    seq_end: 0,
  });
}

export function drawCursors(
  ctx: CanvasRenderingContext2D,
  cursors: Map<string, { x: number; y: number; name: string; color: string }>,
): void {
  ctx.save();
  for (const c of cursors.values()) {
    ctx.fillStyle = c.color;
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(c.x + 10, c.y + 4);
    ctx.lineTo(c.x + 4, c.y + 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillStyle = "#111";
    ctx.fillText(c.name, c.x + 12, c.y + 12);
  }
  ctx.restore();
}

export const COLORS = [
  "#111111",
  "#c41e3a",
  "#0033aa",
  "#0b5d1e",
  "#b36b00",
  "#6b2d8b",
];
