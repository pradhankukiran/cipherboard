import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MsgHandler = ((ev: MessageEvent) => void) | null;

class MockWorker {
  static instances: MockWorker[] = [];
  /** When true, non-init ops stay pending until error/messageerror. */
  static holdOps = false;

  onmessage: MsgHandler = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: MsgHandler = null;
  terminated = false;
  posted: unknown[] = [];

  constructor(
    public url: URL | string,
    _opts?: WorkerOptions,
  ) {
    MockWorker.instances.push(this);
  }

  postMessage(msg: unknown) {
    if (this.terminated) return;
    this.posted.push(msg);
    const m = msg as { id: number; op: string };
    queueMicrotask(() => {
      if (this.terminated) return;
      if (m.op === "init") {
        this.onmessage?.({
          data: { id: m.id, ok: true, result: { protocol: 1 } },
        } as MessageEvent);
        return;
      }
      if (MockWorker.holdOps) return;
      if (m.op === "encode") {
        this.onmessage?.({
          data: { id: m.id, ok: true, result: "encoded" },
        } as MessageEvent);
      }
    });
  }

  terminate() {
    this.terminated = true;
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("boardWorkerClient failure ownership", () => {
  beforeEach(() => {
    MockWorker.instances = [];
    MockWorker.holdOps = false;
    vi.stubGlobal("Worker", MockWorker as unknown as typeof Worker);
  });

  afterEach(() => {
    MockWorker.instances = [];
    MockWorker.holdOps = false;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("rejects pending calls on worker error and recovers on next call", async () => {
    const mod = await import("./boardWorkerClient");
    mod.resetBoardWorkerForTests();

    await mod.initBoardWorker();
    expect(MockWorker.instances).toHaveLength(1);

    MockWorker.holdOps = true;
    const pendingEncode = mod.encodeEvent({ t: "clear" } as never);

    await vi.waitFor(() => {
      const w = MockWorker.instances[0]!;
      expect(
        w.posted.some((p) => (p as { op?: string }).op === "encode"),
      ).toBe(true);
    });

    const worker = MockWorker.instances[0]!;
    // Handler ignores the event payload; invoke directly.
    worker.onerror?.({ message: "boom" } as ErrorEvent);

    await expect(pendingEncode).rejects.toThrow(/worker failure/);
    expect(worker.terminated).toBe(true);

    MockWorker.holdOps = false;
    await expect(mod.encodeEvent({ t: "clear" } as never)).resolves.toBe(
      "encoded",
    );
    expect(MockWorker.instances.length).toBeGreaterThan(1);
  });

  it("rejects all pending on messageerror", async () => {
    const mod = await import("./boardWorkerClient");
    mod.resetBoardWorkerForTests();
    await mod.initBoardWorker();

    MockWorker.holdOps = true;
    const pending = mod.encodeEvent({ t: "clear" } as never);

    await vi.waitFor(() => {
      const w = MockWorker.instances[0]!;
      expect(
        w.posted.some((p) => (p as { op?: string }).op === "encode"),
      ).toBe(true);
    });

    MockWorker.instances[0]!.onmessageerror?.({ data: null } as MessageEvent);
    await expect(pending).rejects.toThrow(/message error/);
    await flush();
  });
});
