import type { BoardEvent, BoardSnapshot, Branch, Point, TimelineEntry } from "./types";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

let worker: Worker | null = null;
let seq = 1;
const pending = new Map<number, Pending>();
let initPromise: Promise<void> | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/board-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (ev: MessageEvent) => {
      const { id, ok, result, error } = ev.data as {
        id: number;
        ok: boolean;
        result?: unknown;
        error?: string;
      };
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error || "worker error"));
    };
    worker.onerror = () => {
      // do not log payload details
    };
  }
  return worker;
}

function call<T>(msg: Record<string, unknown>): Promise<T> {
  const id = seq++;
  const w = getWorker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (v) => resolve(v as T),
      reject,
    });
    w.postMessage({ ...msg, id });
  });
}

export async function initBoardWorker(): Promise<void> {
  if (!initPromise) {
    initPromise = call<{ protocol: number }>({ op: "init" }).then(() => undefined);
  }
  return initPromise;
}

export async function encodeEvent(event: BoardEvent): Promise<string> {
  await initBoardWorker();
  return call<string>({ op: "encode", eventJson: JSON.stringify(event) });
}

export async function decodeEvent(encoded: string): Promise<BoardEvent> {
  await initBoardWorker();
  const json = await call<string>({ op: "decode", encoded });
  return JSON.parse(json) as BoardEvent;
}

function toWorkerEntries(entries: TimelineEntry[]) {
  return entries.map((e) => ({
    seq: e.seq,
    event_id: e.eventId,
    sender_id: e.senderId,
    branch_id: e.branchId,
    event: e.event,
  }));
}

function toWorkerBranches(branches: Branch[]) {
  return branches.map((b) => ({
    id: b.id,
    parent_branch_id: b.parent_branch_id ?? null,
    fork_seq: b.fork_seq ?? null,
  }));
}

export async function replayBranch(
  entries: TimelineEntry[],
  branches: Branch[],
  branchId: string,
  throughSeq: number,
  authorFilter?: string | null,
): Promise<BoardSnapshot> {
  await initBoardWorker();
  const json = await call<string>({
    op: "replay_branch",
    entriesJson: JSON.stringify(toWorkerEntries(entries)),
    branchesJson: JSON.stringify(toWorkerBranches(branches)),
    branchId,
    throughSeq,
    authorFilter: authorFilter ?? null,
  });
  return JSON.parse(json) as BoardSnapshot;
}

export async function branchTimeline(
  entries: TimelineEntry[],
  branches: Branch[],
  branchId: string,
): Promise<TimelineEntry[]> {
  await initBoardWorker();
  const json = await call<string>({
    op: "branch_timeline",
    entriesJson: JSON.stringify(toWorkerEntries(entries)),
    branchesJson: JSON.stringify(toWorkerBranches(branches)),
    branchId,
  });
  const raw = JSON.parse(json) as Array<{
    seq: number;
    event_id: string;
    sender_id: string;
    branch_id: string;
    event: BoardEvent;
  }>;
  return raw.map((e) => ({
    seq: e.seq,
    eventId: e.event_id,
    senderId: e.sender_id,
    branchId: e.branch_id,
    event: e.event,
  }));
}

export async function simplifyPoints(
  points: Point[],
  tolerance = 1.5,
): Promise<Point[]> {
  await initBoardWorker();
  const json = await call<string>({
    op: "simplify",
    pointsJson: JSON.stringify(points),
    tolerance,
  });
  return JSON.parse(json) as Point[];
}
