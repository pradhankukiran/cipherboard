import { useCallback, useEffect, useRef } from "react";
import { drawCursors, drawLiveStroke, paintSnapshot } from "../lib/draw";
import {
  retainUnconfirmedStrokes,
  type PendingLocalStroke,
} from "../lib/pendingStroke";
import type { BoardSnapshot, Point } from "../lib/types";
import { randomId } from "../crypto/keys";

function drawPendingStrokes(
  ctx: CanvasRenderingContext2D,
  pending: PendingLocalStroke[],
) {
  for (const stroke of pending) {
    drawLiveStroke(
      ctx,
      stroke.points,
      stroke.color,
      stroke.width,
      stroke.tool,
    );
  }
}

export function CanvasBoard(props: {
  snapshot: BoardSnapshot;
  cursors: Map<string, { x: number; y: number; name: string; color: string }>;
  tool: "pen" | "eraser";
  color: string;
  width: number;
  disabled?: boolean;
  onBegin: (id: string, color: string, width: number, tool: string) => void;
  onPoints: (id: string, points: Point[]) => void;
  onEnd: (id: string) => void;
  onErase: (id: string, points: Point[], width: number) => void;
  onCursor: (x: number, y: number, visible: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drawing = useRef(false);
  const strokeId = useRef<string | null>(null);
  const points = useRef<Point[]>([]);
  const batchPoints = useRef<Point[]>([]);
  const pendingStrokes = useRef<PendingLocalStroke[]>([]);
  const lastSend = useRef(0);
  const dprRef = useRef(1);

  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    dprRef.current = dpr;
    const rect = wrap.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pendingStrokes.current = props.disabled
      ? []
      : retainUnconfirmedStrokes(pendingStrokes.current, props.snapshot);
    paintSnapshot(ctx, props.snapshot, rect.width, rect.height);
    drawPendingStrokes(ctx, pendingStrokes.current);
    if (drawing.current && points.current.length) {
      drawLiveStroke(
        ctx,
        points.current,
        props.tool === "eraser" ? "#000" : props.color,
        props.width,
        props.tool,
      );
    }
    drawCursors(ctx, props.cursors);
  }, [
    props.snapshot,
    props.cursors,
    props.color,
    props.width,
    props.tool,
    props.disabled,
  ]);

  useEffect(() => {
    resize();
    const ro = new ResizeObserver(() => resize());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [resize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = wrap.getBoundingClientRect();
    ctx.setTransform(dprRef.current, 0, 0, dprRef.current, 0, 0);
    pendingStrokes.current = props.disabled
      ? []
      : retainUnconfirmedStrokes(pendingStrokes.current, props.snapshot);
    paintSnapshot(ctx, props.snapshot, rect.width, rect.height);
    drawPendingStrokes(ctx, pendingStrokes.current);
    if (drawing.current && points.current.length) {
      drawLiveStroke(
        ctx,
        points.current,
        props.tool === "eraser" ? "#000" : props.color,
        props.width,
        props.tool,
      );
    }
    drawCursors(ctx, props.cursors);
  }, [
    props.snapshot,
    props.cursors,
    props.color,
    props.width,
    props.tool,
    props.disabled,
  ]);

  const pos = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      p: e.pressure || 0.5,
    };
  };

  const onPointerDown = async (e: React.PointerEvent) => {
    if (props.disabled) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drawing.current = true;
    const id = await randomId("s");
    strokeId.current = id;
    const p = pos(e);
    points.current = [p];
    batchPoints.current = [p];
    if (props.tool === "eraser") {
      // erase events committed on end / batches
    } else {
      props.onBegin(id, props.color, props.width, "pen");
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pos(e);
    if (!props.disabled) {
      const now = performance.now();
      if (now - lastSend.current > 50) {
        lastSend.current = now;
        props.onCursor(p.x, p.y, true);
      }
    }
    if (!drawing.current || props.disabled) return;
    points.current.push(p);
    batchPoints.current.push(p);
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (canvas && wrap) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const rect = wrap.getBoundingClientRect();
        ctx.setTransform(dprRef.current, 0, 0, dprRef.current, 0, 0);
        paintSnapshot(ctx, props.snapshot, rect.width, rect.height);
        drawPendingStrokes(ctx, pendingStrokes.current);
        drawLiveStroke(
          ctx,
          points.current,
          props.tool === "eraser" ? "#000" : props.color,
          props.width,
          props.tool,
        );
        drawCursors(ctx, props.cursors);
      }
    }
    if (batchPoints.current.length >= 24) {
      const batch = batchPoints.current.slice();
      batchPoints.current = [batch[batch.length - 1]!];
      const id = strokeId.current!;
      if (props.tool === "eraser") {
        void props.onErase(id, batch, props.width);
        void randomId("s").then((nid) => {
          strokeId.current = nid;
        });
      } else {
        props.onPoints(id, batch);
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    drawing.current = false;
    const id = strokeId.current;
    const pts = points.current;
    const batch = batchPoints.current;
    points.current = [];
    batchPoints.current = [];
    strokeId.current = null;
    if (!id || props.disabled) return;
    if (pts.length) {
      pendingStrokes.current.push({
        id,
        color: props.tool === "eraser" ? "#000" : props.color,
        width: props.width,
        tool: props.tool,
        points: pts,
      });
    }
    if (props.tool === "eraser") {
      if (batch.length) props.onErase(id, batch, props.width);
    } else {
      if (batch.length) props.onPoints(id, batch);
      props.onEnd(id);
    }
    props.onCursor(pos(e).x, pos(e).y, true);
  };

  const onPointerLeave = () => {
    props.onCursor(0, 0, false);
  };

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Collaborative whiteboard canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
      />
    </div>
  );
}

export function exportPng(snapshot: BoardSnapshot, w = 1600, h = 900): string {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  paintSnapshot(ctx, snapshot, w, h);
  return canvas.toDataURL("image/png");
}
