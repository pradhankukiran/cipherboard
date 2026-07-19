import type { BoardSnapshot, Point } from "./types";

export type PendingLocalStroke = {
  id: string;
  color: string;
  width: number;
  tool: string;
  points: Point[];
};

export function retainUnconfirmedStrokes(
  pending: PendingLocalStroke[],
  snapshot: BoardSnapshot,
): PendingLocalStroke[] {
  const confirmedIds = new Set(snapshot.strokes.map((stroke) => stroke.id));
  return pending.filter((stroke) => !confirmedIds.has(stroke.id));
}
