import { describe, expect, it } from "vitest";
import { createRevisionGate, createSerialQueue } from "./asyncOrder";

describe("createRevisionGate", () => {
  it("only latest token is current", () => {
    const g = createRevisionGate();
    const a = g.next();
    expect(g.isCurrent(a)).toBe(true);
    const b = g.next();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });

  it("invalidate drops outstanding tokens", () => {
    const g = createRevisionGate();
    const a = g.next();
    g.invalidate();
    expect(g.isCurrent(a)).toBe(false);
  });
});

describe("createSerialQueue", () => {
  it("runs tasks in enqueue order", async () => {
    const q = createSerialQueue();
    const order: number[] = [];
    const p1 = q.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
      return 1;
    });
    const p2 = q.enqueue(async () => {
      order.push(2);
      return 2;
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("failure does not poison subsequent tasks", async () => {
    const q = createSerialQueue();
    const p1 = q.enqueue(async () => {
      throw new Error("boom");
    });
    const p2 = q.enqueue(async () => "ok");
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
  });

  it("invalidate rejects stale work and permits newly queued work", async () => {
    const q = createSerialQueue();
    let started = false;
    const slow = q.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return "slow";
    });
    q.invalidate();
    const later = q.enqueue(async () => {
      started = true;
      return "later";
    });
    // After invalidate, new enqueue uses new generation — should run
    await expect(later).resolves.toBe("later");
    expect(started).toBe(true);
    await expect(slow).rejects.toThrow("queue invalidated");
  });
});
