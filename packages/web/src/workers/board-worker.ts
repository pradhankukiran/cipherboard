/**
 * Web Worker for Wasm event encode/decode and timeline replay.
 * Never receives CryptoKeys or secret key material.
 */

import init, {
  decode_event,
  encode_event,
  fork_snapshot,
  protocol_version,
  replay_through,
  simplify_stroke,
  smooth_stroke,
} from "../wasm/pkg/cipherboard_wasm.js";

type InMsg =
  | { id: number; op: "init" }
  | { id: number; op: "encode"; eventJson: string }
  | { id: number; op: "decode"; encoded: string }
  | {
      id: number;
      op: "replay";
      entriesJson: string;
      throughSeq: number;
      authorFilter?: string | null;
    }
  | { id: number; op: "fork"; entriesJson: string; forkSeq: number }
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
      case "replay":
        self.postMessage({
          id: msg.id,
          ok: true,
          result: replay_through(
            msg.entriesJson,
            BigInt(msg.throughSeq),
            msg.authorFilter ?? undefined,
          ),
        });
        break;
      case "fork":
        self.postMessage({
          id: msg.id,
          ok: true,
          result: fork_snapshot(msg.entriesJson, BigInt(msg.forkSeq)),
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
      error: e instanceof Error ? e.message : String(e),
    });
  }
};
