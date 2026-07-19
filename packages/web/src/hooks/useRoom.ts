import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CryptoSession, type PeerInfo } from "../crypto/session";
import { randomId, verifyFingerprint } from "../crypto/keys";
import { wsProtocols, wsUrl } from "../lib/api";
import {
  decodeEvent,
  encodeEvent,
  replayBranch,
  simplifyPoints,
} from "../lib/boardWorkerClient";
import type {
  BoardEvent,
  BoardSnapshot,
  Branch,
  ConnStatus,
  Participant,
  Point,
  TimelineEntry,
} from "../lib/types";

export type RoomSession = {
  roomId: string;
  participantId: string;
  sessionToken: string;
  displayName: string;
  role: string;
  publicKeySpkiB64: string;
  fingerprint: string;
  privateKey: CryptoKey;
  branchId: string;
  inviteCode?: string;
};

type ServerMsg = {
  type: string;
  [k: string]: unknown;
};

const MAX_RECONNECT_MS = 15000;
const EPHEMERAL_BRANCH = "ephemeral";

export function useRoom(session: RoomSession | null) {
  const [status, setStatus] = useState<ConnStatus>("closed");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [locked, setLocked] = useState(false);
  const [myStatus, setMyStatus] = useState(
    session?.role === "host" ? "approved" : "waiting",
  );
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [snapshot, setSnapshot] = useState<BoardSnapshot>({
    strokes: [],
    undo_stack: [],
    redo_stack: [],
    last_seq: 0,
  });
  const [scrubSeq, setScrubSeq] = useState<number | null>(null);
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);
  const [activeBranchId, setActiveBranchId] = useState(session?.branchId ?? "");
  const [cursors, setCursors] = useState<
    Map<string, { x: number; y: number; name: string; color: string }>
  >(new Map());
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const cryptoRef = useRef<CryptoSession | null>(null);
  const timelineRef = useRef<TimelineEntry[]>([]);
  const peersRef = useRef<Participant[]>([]);
  const branchesRef = useRef<Branch[]>([]);
  const branchRef = useRef(activeBranchId);
  const sessionRef = useRef(session);
  const scrubRef = useRef(scrubSeq);
  const authorRef = useRef(authorFilter);
  const myStatusRef = useRef(myStatus);
  const intentionalClose = useRef(false);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    branchRef.current = activeBranchId;
  }, [activeBranchId]);
  useEffect(() => {
    peersRef.current = participants;
  }, [participants]);
  useEffect(() => {
    branchesRef.current = branches;
  }, [branches]);
  useEffect(() => {
    timelineRef.current = timeline;
  }, [timeline]);
  useEffect(() => {
    scrubRef.current = scrubSeq;
  }, [scrubSeq]);
  useEffect(() => {
    authorRef.current = authorFilter;
  }, [authorFilter]);
  useEffect(() => {
    myStatusRef.current = myStatus;
  }, [myStatus]);

  const rebuildSnapshot = useCallback(
    async (
      entries: TimelineEntry[],
      branchList: Branch[],
      branchId: string,
      through: number | null,
      author: string | null,
    ) => {
      if (!branchId) {
        setSnapshot({
          strokes: [],
          undo_stack: [],
          redo_stack: [],
          last_seq: 0,
        });
        return;
      }
      const maxSeq = entries.reduce((m, e) => Math.max(m, e.seq), 0) || 0;
      const thru = through ?? maxSeq;
      try {
        const snap = await replayBranch(
          entries,
          branchList,
          branchId,
          thru,
          author,
        );
        setSnapshot(snap);
      } catch {
        // avoid logging sensitive timeline material
      }
    },
    [],
  );

  const send = useCallback((obj: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }, []);

  const approvedPeers = useCallback((): PeerInfo[] => {
    return peersRef.current
      .filter((p) => p.status === "approved")
      .map((p) => ({
        id: p.id,
        publicKeySpki: p.public_key_spki,
        fingerprint: p.fingerprint,
        status: p.status,
      }));
  }, []);

  const publishDurable = useCallback(
    async (event: BoardEvent) => {
      const s = sessionRef.current;
      const crypto = cryptoRef.current;
      if (!s || !crypto || myStatusRef.current !== "approved") return;
      if (scrubRef.current !== null) return;

      const encoded = await encodeEvent(event);
      const eventId = await randomId("ev");
      const peers = approvedPeers();
      const envelopes = await crypto.sealForPeersIncludingSelf(
        encoded,
        eventId,
        branchRef.current,
        peers,
        s.publicKeySpkiB64,
        s.fingerprint,
      );
      if (envelopes.length === 0) return;
      send({
        type: "relay_envelopes",
        branch_id: branchRef.current,
        event_id: eventId,
        envelopes: envelopes.map((e) => ({
          recipient_id: e.recipientId,
          iv_b64: e.ivB64,
          ciphertext_b64: e.ciphertextB64,
          aad_json: e.aadJson,
          protocol_version: e.protocolVersion,
        })),
      });
    },
    [approvedPeers, send],
  );

  const publishEphemeral = useCallback(
    async (event: BoardEvent) => {
      const s = sessionRef.current;
      const crypto = cryptoRef.current;
      if (!s || !crypto || myStatusRef.current !== "approved") return;
      const peers = approvedPeers().filter((p) => p.id !== s.participantId);
      if (peers.length === 0) return;
      const encoded = await encodeEvent(event);
      const eventId = await randomId("cur");
      const envelopes = await crypto.sealForPeers(
        encoded,
        eventId,
        EPHEMERAL_BRANCH,
        peers,
      );
      if (envelopes.length === 0) return;
      send({
        type: "relay_ephemeral",
        event_id: eventId,
        envelopes: envelopes.map((e) => ({
          recipient_id: e.recipientId,
          iv_b64: e.ivB64,
          ciphertext_b64: e.ciphertextB64,
          aad_json: e.aadJson,
          protocol_version: e.protocolVersion,
        })),
      });
    },
    [approvedPeers, send],
  );

  useEffect(() => {
    if (!session) return;
    intentionalClose.current = false;
    const gen = ++generation.current;

    cryptoRef.current = new CryptoSession({
      privateKey: session.privateKey,
      roomId: session.roomId,
      selfId: session.participantId,
    });

    if (session.branchId) setActiveBranchId(session.branchId);
    setMyStatus(session.role === "host" ? "approved" : "waiting");

    function clearReconnect() {
      if (reconnectTimer.current != null) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    }

    function scheduleReconnect() {
      if (intentionalClose.current || generation.current !== gen) return;
      const attempt = reconnectAttempt.current++;
      const delay = Math.min(
        MAX_RECONNECT_MS,
        500 * Math.pow(2, attempt) + Math.random() * 200,
      );
      setStatus("connecting");
      clearReconnect();
      reconnectTimer.current = window.setTimeout(() => {
        if (generation.current === gen && !intentionalClose.current) {
          openSocket();
        }
      }, delay);
    }

    async function handleServerMessage(msg: ServerMsg) {
      if (generation.current !== gen) return;
      const s = sessionRef.current;
      const crypto = cryptoRef.current;
      if (!s || !crypto) return;

      switch (msg.type) {
        case "welcome":
          setMyStatus(String(msg.status));
          if (msg.branch_id) {
            setActiveBranchId((cur) => cur || String(msg.branch_id));
          }
          break;
        case "error":
          setError(String(msg.message ?? "error"));
          break;
        case "room_state": {
          setLocked(Boolean(msg.locked));
          const parts = await sanitizeParticipants(
            (msg.participants as Participant[]) ?? [],
          );
          setParticipants(parts);
          const br = (msg.branches as Branch[]) ?? [];
          setBranches(br);
          const me = parts.find((p) => p.id === s.participantId);
          if (me) setMyStatus(me.status);
          break;
        }
        case "participant_updated": {
          const raw = msg.participant as Participant;
          const verified = await sanitizeParticipant(raw);
          if (!verified) break;
          setParticipants((prev) => {
            const idx = prev.findIndex((x) => x.id === verified.id);
            let next =
              idx >= 0
                ? prev.map((x) => (x.id === verified.id ? verified : x))
                : [...prev, verified];
            next = next.filter(
              (x) => x.status !== "rejected" && x.status !== "removed",
            );
            return next;
          });
          if (verified.id === s.participantId) setMyStatus(verified.status);
          if (verified.status === "removed") {
            crypto.dropPeerKeys(verified.id);
            setCursors((prev) => {
              const n = new Map(prev);
              n.delete(verified.id);
              return n;
            });
          }
          if (
            s.role === "host" &&
            verified.status === "approved" &&
            verified.id !== s.participantId
          ) {
            await sendHistoryPackage(verified);
          }
          break;
        }
        case "envelope": {
          await handleEnvelope(msg, false);
          break;
        }
        case "ephemeral": {
          await handleEnvelope(msg, true);
          break;
        }
        case "history_package": {
          if (String(msg.to_participant_id) !== s.participantId) return;
          const fromId = String(msg.from_participant_id);
          const sender = peersRef.current.find((p) => p.id === fromId);
          if (!sender) return;
          const plain = await crypto.openEnvelope({
            sender: {
              id: sender.id,
              publicKeySpki: sender.public_key_spki,
              fingerprint: sender.fingerprint,
              status: sender.status,
            },
            ivB64: String(msg.iv_b64),
            ciphertextB64: String(msg.ciphertext_b64),
            aadJson: String(msg.aad_json),
            eventId: String(msg.event_id),
            branchId: String(msg.branch_id),
            recipientId: s.participantId,
          });
          if (!plain) return;
          const packed = JSON.parse(plain) as {
            entries: Array<{
              seq: number;
              event_id: string;
              sender_id: string;
              branch_id: string;
              event_json: string;
            }>;
          };
          const restored: TimelineEntry[] = [];
          for (const e of packed.entries) {
            const event = await decodeEvent(e.event_json);
            if (event.t === "cursor") continue;
            restored.push({
              seq: e.seq,
              eventId: e.event_id,
              senderId: e.sender_id,
              branchId: e.branch_id,
              event,
            });
          }
          setTimeline((prev) => {
            const map = new Map(
              [...prev, ...restored].map((x) => [
                `${x.senderId}:${x.eventId}`,
                x,
              ]),
            );
            const next = [...map.values()].sort((a, b) => a.seq - b.seq);
            void rebuildSnapshot(
              next,
              branchesRef.current,
              branchRef.current,
              scrubRef.current,
              authorRef.current,
            );
            return next;
          });
          break;
        }
        case "branch_created": {
          const b = msg.branch as Branch;
          setBranches((prev) =>
            prev.some((x) => x.id === b.id) ? prev : [...prev, b],
          );
          break;
        }
        default:
          break;
      }
    }

    async function handleEnvelope(msg: ServerMsg, ephemeral: boolean) {
      const s = sessionRef.current;
      const crypto = cryptoRef.current;
      if (!s || !crypto) return;
      if (String(msg.recipient_id) !== s.participantId) return;
      const senderId = String(msg.sender_id);
      const sender = peersRef.current.find((p) => p.id === senderId);
      const peer: PeerInfo = sender
        ? {
            id: sender.id,
            publicKeySpki: sender.public_key_spki,
            fingerprint: sender.fingerprint,
            status: sender.status,
          }
        : {
            id: s.participantId,
            publicKeySpki: s.publicKeySpkiB64,
            fingerprint: s.fingerprint,
            status: "approved",
          };
      if (sender && sender.status === "removed") return;

      const branchId = ephemeral
        ? EPHEMERAL_BRANCH
        : String(msg.branch_id);

      let plain: string | null;
      try {
        plain = await crypto.openEnvelope({
          sender: peer,
          ivB64: String(msg.iv_b64),
          ciphertextB64: String(msg.ciphertext_b64),
          aadJson: String(msg.aad_json),
          eventId: String(msg.event_id),
          branchId,
          recipientId: s.participantId,
        });
      } catch {
        return;
      }
      if (plain == null) return;
      const event = await decodeEvent(plain);
      if (event.t === "cursor") {
        const name =
          peersRef.current.find((p) => p.id === senderId)?.display_name ?? "peer";
        setCursors((prev) => {
          const next = new Map(prev);
          if (!event.visible) next.delete(senderId);
          else
            next.set(senderId, {
              x: event.x,
              y: event.y,
              name,
              color: colorFor(senderId),
            });
          return next;
        });
        return;
      }
      if (ephemeral) return;
      const entry: TimelineEntry = {
        seq: Number(msg.seq),
        eventId: String(msg.event_id),
        senderId,
        branchId: String(msg.branch_id),
        event,
      };
      setTimeline((prev) => {
        if (
          prev.some(
            (e) => e.eventId === entry.eventId && e.senderId === entry.senderId,
          )
        ) {
          return prev;
        }
        const next = [...prev, entry].sort((a, b) => a.seq - b.seq);
        void rebuildSnapshot(
          next,
          branchesRef.current,
          branchRef.current,
          scrubRef.current,
          authorRef.current,
        );
        return next;
      });
    }

    async function sendHistoryPackage(target: Participant) {
      const s = sessionRef.current;
      const crypto = cryptoRef.current;
      if (!s || !crypto) return;
      const entries = timelineRef.current.filter((e) => e.event.t !== "cursor");
      // Include inherited branch content for active branch
      const payload = {
        entries: await Promise.all(
          entries.map(async (e) => ({
            seq: e.seq,
            event_id: e.eventId,
            sender_id: e.senderId,
            branch_id: e.branchId,
            event_json: await encodeEvent(e.event),
          })),
        ),
      };
      const eventId = await randomId("hist");
      const sealed = await crypto.sealForPeers(
        JSON.stringify(payload),
        eventId,
        branchRef.current,
        [
          {
            id: target.id,
            publicKeySpki: target.public_key_spki,
            fingerprint: target.fingerprint,
            status: "approved",
          },
        ],
      );
      const env = sealed[0];
      if (!env) return;
      const through = entries.reduce((m, e) => Math.max(m, e.seq), 0);
      send({
        type: "history_package",
        event_id: eventId,
        branch_id: branchRef.current,
        to_participant_id: target.id,
        through_seq: through,
        iv_b64: env.ivB64,
        ciphertext_b64: env.ciphertextB64,
        aad_json: env.aadJson,
      });
    }

    function openSocket() {
      if (generation.current !== gen || intentionalClose.current) return;
      // Close any prior socket without scheduling reconnect from its onclose
      const prev = wsRef.current;
      if (prev) {
        prev.onclose = null;
        prev.onerror = null;
        prev.onmessage = null;
        prev.close();
      }

      setStatus("connecting");
      const s = sessionRef.current;
      if (!s) return;

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl(), wsProtocols(s.sessionToken));
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (generation.current !== gen) return;
        reconnectAttempt.current = 0;
        setStatus("open");
        setError(null);
      };
      ws.onerror = () => {
        if (generation.current !== gen) return;
        setStatus("error");
      };
      ws.onclose = () => {
        if (generation.current !== gen) return;
        wsRef.current = null;
        if (!intentionalClose.current) {
          setStatus("connecting");
          scheduleReconnect();
        } else {
          setStatus("closed");
        }
      };
      ws.onmessage = async (ev) => {
        if (generation.current !== gen) return;
        let msg: ServerMsg;
        try {
          msg = JSON.parse(String(ev.data)) as ServerMsg;
        } catch {
          return;
        }
        try {
          await handleServerMessage(msg);
        } catch {
          // swallow; no secret logging
        }
      };
    }

    openSocket();

    const ping = window.setInterval(() => {
      send({ type: "ping", ts: Date.now() });
    }, 20000);

    return () => {
      intentionalClose.current = true;
      generation.current += 1;
      clearReconnect();
      window.clearInterval(ping);
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      wsRef.current = null;
    };
  }, [session?.roomId, session?.sessionToken, rebuildSnapshot, send]);

  useEffect(() => {
    void rebuildSnapshot(
      timeline,
      branches,
      activeBranchId,
      scrubSeq,
      authorFilter,
    );
  }, [timeline, branches, activeBranchId, scrubSeq, authorFilter, rebuildSnapshot]);

  const approve = useCallback(
    (id: string) => send({ type: "approve", target_id: id }),
    [send],
  );
  const reject = useCallback(
    (id: string) => send({ type: "reject", target_id: id }),
    [send],
  );
  const remove = useCallback(
    (id: string) => {
      send({ type: "remove", target_id: id });
      cryptoRef.current?.dropPeerKeys(id);
    },
    [send],
  );
  const setLock = useCallback(
    (locked: boolean) => send({ type: "lock", locked }),
    [send],
  );

  const beginStroke = useCallback(
    async (id: string, color: string, width: number, tool: string) => {
      await publishDurable({ t: "stroke_begin", id, color, width, tool });
    },
    [publishDurable],
  );
  const addStrokePoints = useCallback(
    async (id: string, points: Point[]) => {
      const simplified =
        points.length > 8 ? await simplifyPoints(points, 1.2) : points;
      await publishDurable({ t: "stroke_points", id, points: simplified });
    },
    [publishDurable],
  );
  const endStroke = useCallback(
    async (id: string) => {
      await publishDurable({ t: "stroke_end", id });
    },
    [publishDurable],
  );
  const erase = useCallback(
    async (id: string, points: Point[], width: number) => {
      const simplified =
        points.length > 8 ? await simplifyPoints(points, 1.2) : points;
      await publishDurable({ t: "erase", id, points: simplified, width });
    },
    [publishDurable],
  );
  const clearBoard = useCallback(async () => {
    await publishDurable({ t: "clear", nonce: await randomId("clr") });
  }, [publishDurable]);
  const undo = useCallback(async () => {
    const target = snapshot.undo_stack.at(-1);
    if (target) await publishDurable({ t: "undo", target });
  }, [publishDurable, snapshot.undo_stack]);
  const redo = useCallback(async () => {
    const target = snapshot.redo_stack.at(-1);
    if (target) await publishDurable({ t: "redo", target });
  }, [publishDurable, snapshot.redo_stack]);
  const sendCursor = useCallback(
    async (x: number, y: number, visible: boolean) => {
      await publishEphemeral({ t: "cursor", x, y, visible });
    },
    [publishEphemeral],
  );

  const forkBranch = useCallback(
    async (name: string, forkSeq: number) => {
      send({
        type: "create_branch",
        name,
        parent_branch_id: activeBranchId,
        fork_seq: forkSeq,
      });
    },
    [activeBranchId, send],
  );

  const maxSeq = useMemo(() => snapshot.last_seq, [snapshot.last_seq]);

  return {
    status,
    participants,
    branches,
    locked,
    myStatus,
    snapshot,
    timeline,
    scrubSeq,
    setScrubSeq,
    authorFilter,
    setAuthorFilter,
    activeBranchId,
    setActiveBranchId,
    cursors,
    error,
    maxSeq,
    approve,
    reject,
    remove,
    setLock,
    beginStroke,
    addStrokePoints,
    endStroke,
    erase,
    clearBoard,
    undo,
    redo,
    sendCursor,
    forkBranch,
  };
}

async function sanitizeParticipant(
  p: Participant,
): Promise<Participant | null> {
  try {
    const ok = await verifyFingerprint(p.public_key_spki, p.fingerprint);
    if (!ok) return null;
    const fp = p.fingerprint;
    return { ...p, fingerprint: fp };
  } catch {
    return null;
  }
}

async function sanitizeParticipants(
  list: Participant[],
): Promise<Participant[]> {
  const out: Participant[] = [];
  for (const p of list) {
    const v = await sanitizeParticipant(p);
    if (v) out.push(v);
  }
  return out;
}

function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const palette = ["#c41e3a", "#0033aa", "#0b5d1e", "#b36b00", "#6b2d8b", "#111"];
  return palette[h % palette.length]!;
}
