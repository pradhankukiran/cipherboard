import type { BoardSnapshot, Point } from "./types";

export type PendingLocalStroke = {
  id: string;
  color: string;
  width: number;
  tool: string;
  points: Point[];
};

const ENDPOINT_TOLERANCE = 1e-3;

function sameXY(a: Point, b: Point): boolean {
  return (
    Math.abs(a.x - b.x) <= ENDPOINT_TOLERANCE &&
    Math.abs(a.y - b.y) <= ENDPOINT_TOLERANCE
  );
}

/** True once replay's ordered tip matches the local stroke's final endpoint (x/y). */
function confirmedCoversLocalEndpoint(
  confirmedPoints: Point[],
  localPoints: Point[],
): boolean {
  const confirmedTip = confirmedPoints.at(-1);
  const localTip = localPoints.at(-1);
  if (!confirmedTip || !localTip) return false;
  return sameXY(confirmedTip, localTip);
}

export function retainUnconfirmedStrokes(
  pending: PendingLocalStroke[],
  snapshot: BoardSnapshot,
): PendingLocalStroke[] {
  const confirmedById = new Map(
    snapshot.strokes.map((stroke) => [stroke.id, stroke] as const),
  );
  return pending.filter((stroke) => {
    const confirmed = confirmedById.get(stroke.id);
    if (!confirmed) return true;
    if (confirmed.points.length === 0) return true;
    return !confirmedCoversLocalEndpoint(confirmed.points, stroke.points);
  });
}
