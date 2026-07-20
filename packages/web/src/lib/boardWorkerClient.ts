import type { BoardEvent, BoardSnapshot, Branch, Point, TimelineEntry } from "./types";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

let worker: Worker | null = null;
let seq = 1;
const pending = new Map<number, Pending>();
let initPromise: Promise<void> | null = null;

function rejectAllPending(error: Error): void {
  const waiters = [...pending.values()];
  pending.clear();
  for (const p of waiters) {
    p.reject(error);
  }
}

/** Terminate worker, fail pending calls, and clear init so a later call recovers. */
function resetWorker(error?: Error): void {
  if (error) {
    rejectAllPending(error);
  } else if (pending.size > 0) {
    rejectAllPending(new Error("worker reset"));
  }
  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    try {
      worker.terminate();
    } catch {
      // ignore terminate races
    }
    worker = null;
  }
  initPromise = null;
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/board-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (ev: MessageEvent) => {
      const data = ev.data as {
        id?: number;
        ok?: boolean;
        result?: unknown;
        error?: string;
      };
      // Do not log payloads.
      if (typeof data?.id !== "number") return;
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.ok) p.resolve(data.result);
      else p.reject(new Error(data.error || "worker error"));
    };
    worker.onerror = () => {
      // Ownership: fail pending, drop worker, allow later recovery.
      resetWorker(new Error("worker failure"));
    };
    worker.onmessageerror = () => {
      resetWorker(new Error("worker message error"));
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
    try {
      w.postMessage({ ...msg, id });
    } catch {
      pending.delete(id);
      resetWorker(new Error("worker post failed"));
      reject(new Error("worker post failed"));
    }
  });
}

/** Test seam: force worker teardown without logging. */
export function resetBoardWorkerForTests(): void {
  resetWorker(new Error("test reset"));
}

export async function initBoardWorker(): Promise<void> {
  if (!initPromise) {
    initPromise = call<{ protocol: number }>({ op: "init" })
      .then(() => undefined)
      .catch((e: unknown) => {
        initPromise = null;
        throw e instanceof Error ? e : new Error("worker init failed");
      });
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
