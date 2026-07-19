/**
 * Web Worker for Wasm event encode/decode and timeline replay.
 * Never receives CryptoKeys or secret key material.
 */

import init, {
  branch_timeline,
  decode_event,
  encode_event,
  protocol_version,
  replay_branch,
  simplify_stroke,
  smooth_stroke,
} from "../wasm/pkg/cipherboard_wasm.js";

type InMsg =
  | { id: number; op: "init" }
  | { id: number; op: "encode"; eventJson: string }
  | { id: number; op: "decode"; encoded: string }
  | {
      id: number;
      op: "replay_branch";
      entriesJson: string;
      branchesJson: string;
      branchId: string;
      throughSeq: number;
      authorFilter?: string | null;
    }
  | {
      id: number;
      op: "branch_timeline";
      entriesJson: string;
      branchesJson: string;
      branchId: string;
    }
  | { id: number; op: "smooth"; pointsJson: string; iterations: number }
  | { id: number; op: "simplify"; pointsJson: string; tolerance: number };

let ready = false;

async function ensureInit() {
  if (!ready) {
    await init();
    ready = true;
  }
}

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  try {
    await ensureInit();
    switch (msg.op) {
      case "init":
        self.postMessage({
          id: msg.id,
          ok: true,
          result: { protocol: protocol_version() },
        });
        break;
      case "encode":
        self.postMessage({
          id: msg.id,
          ok: true,
          result: encode_event(msg.eventJson),
        });
        break;
      case "decode":
        self.postMessage({
          id: msg.id,
          ok: true,
          result: decode_event(msg.encoded),
        });
        break;
      case "replay_branch":
        self.postMessage({
          id: msg.id,
          ok: true,
          result: replay_branch(
            msg.entriesJson,
            msg.branchesJson,
            msg.branchId,
            BigInt(msg.throughSeq),
            msg.authorFilter ?? undefined,
          ),
        });
        break;
      case "branch_timeline":
        self.postMessage({
          id: msg.id,
          ok: true,
          result: branch_timeline(msg.entriesJson, msg.branchesJson, msg.branchId),
        });
        break;
      case "smooth":
        self.postMessage({
          id: msg.id,
          ok: true,
          result: smooth_stroke(msg.pointsJson, msg.iterations),
        });
        break;
      case "simplify":
        self.postMessage({
          id: msg.id,
          ok: true,
          result: simplify_stroke(msg.pointsJson, msg.tolerance),
        });
        break;
      default:
        self.postMessage({ id: (msg as InMsg).id, ok: false, error: "unknown op" });
    }
  } catch (e) {
    self.postMessage({
      id: msg.id,
      ok: false,
      error: e instanceof Error ? e.message : "worker failure",
    });
  }
};
