export type Participant = {
  id: string;
  display_name: string;
  public_key_spki: string;
  fingerprint: string;
  role: string;
  status: string;
};

export type Branch = {
  id: string;
  name: string;
  parent_branch_id?: string | null;
  fork_seq?: number | null;
};

export type Point = { x: number; y: number; p: number };

export type BoardEvent =
  | { t: "stroke_begin"; id: string; color: string; width: number; tool: string }
  | { t: "stroke_points"; id: string; points: Point[] }
  | { t: "stroke_end"; id: string }
  | { t: "erase"; id: string; points: Point[]; width: number }
  | { t: "clear"; nonce: string }
  | { t: "undo"; target: string }
  | { t: "redo"; target: string }
  | { t: "cursor"; x: number; y: number; visible: boolean }
  | { t: "snapshot_marker"; label: string };

export type TimelineEntry = {
  seq: number;
  eventId: string;
  senderId: string;
  branchId: string;
  event: BoardEvent;
};

export type StrokeRecord = {
  id: string;
  sender_id: string;
  color: string;
  width: number;
  tool: string;
  points: Point[];
  erased: boolean;
  seq_begin: number;
  seq_end: number;
};

export type BoardSnapshot = {
  strokes: StrokeRecord[];
  undo_stack: string[];
  redo_stack: string[];
  last_seq: number;
};

export type ConnStatus = "connecting" | "open" | "closed" | "error";
