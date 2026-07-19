import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CryptoSession, type PeerInfo } from "../crypto/session";
import { randomId } from "../crypto/keys";
import { wsUrl } from "../lib/api";
import {
  decodeEvent,
  encodeEvent,
  replayThrough,
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
  epoch: number;
};

type ServerMsg = {
  type: string;
  [k: string]: unknown;
};

export function useRoom(session: RoomSession | null) {
  const [status, setStatus] = useState<ConnStatus>("closed");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [locked, setLocked] = useState(false);
  const [myStatus, setMyStatus] = useState(session?.role === "host" ? "approved" : "waiting");
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
  const [localEpoch, setLocalEpoch] = useState(session?.epoch ?? 0);

  const wsRef = useRef<WebSocket | null>(null);
  const cryptoRef = useRef<CryptoSession | null>(null);
  const timelineRef = useRef<TimelineEntry[]>([]);
  const peersRef = useRef<Participant[]>([]);
  const branchRef = useRef(activeBranchId);
  const sessionRef = useRef(session);

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
    timelineRef.current = timeline;
  }, [timeline]);

  const rebuildSnapshot = useCallback(
    async (entries: TimelineEntry[], through: number | null, author: string | null) => {
      const maxSeq =
        entries.reduce((m, e) => Math.max(m, e.seq), 0) || 0;
      const thru = through ?? maxSeq;
      if (entries.length === 0) {
        setSnapshot({
          strokes: [],
          undo_stack: [],
          redo_stack: [],
          last_seq: 0,
        });
        return;
      }
      try {
        const snap = await replayThrough(entries, thru, author);
        setSnapshot(snap);
      } catch (e) {
        console.error("replay failed", e);
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

  const publishEvent = useCallback(
    async (event: BoardEvent) => {
      const s = sessionRef.current;
      const crypto = cryptoRef.current;
      if (!s || !crypto || myStatus !== "approved") return;
      if (scrubSeq !== null) return; // don't draw while scrubbing history

      const encoded = await encodeEvent(event);
      const eventId = await randomId("ev");
      const peers: PeerInfo[] = peersRef.current.map((p) => ({
        id: p.id,
        publicKeySpki: p.public_key_spki,
        status: p.status,
      }));
      const envelopes = await crypto.sealForPeersIncludingSelf(
        encoded,
        eventId,
        branchRef.current,
        peers,
        s.publicKeySpkiB64,
      );
      if (envelopes.length === 0) {
        // solo room — apply locally
        const entry: TimelineEntry = {
          seq: (timelineRef.current.at(-1)?.seq ?? 0) + 1,
          eventId,
          senderId: s.participantId,
          branchId: branchRef.current,
          event,
        };
        const next = [...timelineRef.current, entry];
        setTimeline(next);
        await rebuildSnapshot(next, null, authorFilter);
        return;
      }
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
    [authorFilter, myStatus, rebuildSnapshot, scrubSeq, send],
  );

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setStatus("connecting");
    setMyStatus(session.role === "host" ? "approved" : myStatus);
    setActiveBranchId(session.branchId);
    setLocalEpoch(session.epoch);

    cryptoRef.current = new CryptoSession({
      privateKey: session.privateKey,
      roomId: session.roomId,
      selfId: session.participantId,
      epoch: session.epoch,
    });

    const ws = new WebSocket(wsUrl(session.sessionToken));
    wsRef.current = ws;

    ws.onopen = () => {
      if (!cancelled) setStatus("open");
    };
    ws.onerror = () => {
      if (!cancelled) {
        setStatus("error");
        setError("WebSocket error");
      }
    };
    ws.onclose = () => {
      if (!cancelled) setStatus("closed");
    };
    ws.onmessage = async (ev) => {
      if (cancelled) return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      try {
        await handleServerMessage(msg);
      } catch (e) {
        console.error("handle message failed", e);
      }
    };

    async function handleServerMessage(msg: ServerMsg) {
      const s = sessionRef.current;
      const crypto = cryptoRef.current;
      if (!s || !crypto) return;

      switch (msg.type) {
        case "welcome":
          setMyStatus(String(msg.status));
          if (msg.branch_id) setActiveBranchId(String(msg.branch_id));
          break;
        case "error":
          setError(String(msg.message ?? "error"));
          break;
        case "room_state": {
          setLocked(Boolean(msg.locked));
          const parts = (msg.participants as Participant[]) ?? [];
          setParticipants(parts);
          const br = (msg.branches as Branch[]) ?? [];
          setBranches(br);
          const me = parts.find((p) => p.id === s.participantId);
          if (me) setMyStatus(me.status);
          break;
        }
        case "participant_updated": {
          const p = msg.participant as Participant;
          setParticipants((prev) => {
            const idx = prev.findIndex((x) => x.id === p.id);
            const next =
              idx >= 0
                ? prev.map((x) => (x.id === p.id ? p : x))
                : [...prev, p];
            return next.filter((x) => x.status !== "rejected");
          });
          if (p.id === s.participantId) setMyStatus(p.status);
          if (p.status === "removed") {
            const ep = crypto.bumpEpoch();
            setLocalEpoch(ep);
          }
          // Host sends history when approving
          if (
            s.role === "host" &&
            p.status === "approved" &&
            p.id !== s.participantId
          ) {
            await sendHistoryPackage(p);
          }
          break;
        }
        case "envelope": {
          if (String(msg.recipient_id) !== s.participantId) return;
          const senderId = String(msg.sender_id);
          const sender = peersRef.current.find((p) => p.id === senderId);
          if (!sender && senderId !== s.participantId) return;
          const peer: PeerInfo = sender
            ? {
                id: sender.id,
                publicKeySpki: sender.public_key_spki,
                status: sender.status,
              }
            : {
                id: s.participantId,
                publicKeySpki: s.publicKeySpkiB64,
                status: "approved",
              };
          const plain = await crypto.openEnvelope(
            peer,
            String(msg.iv_b64),
            String(msg.ciphertext_b64),
            String(msg.aad_json),
            String(msg.event_id),
          );
          if (plain == null) return;
          const event = await decodeEvent(plain);
          if (event.t === "cursor") {
            const name =
              peersRef.current.find((p) => p.id === senderId)?.display_name ??
              "peer";
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
          const entry: TimelineEntry = {
            seq: Number(msg.seq),
            eventId: String(msg.event_id),
            senderId,
            branchId: String(msg.branch_id),
            event,
          };
          if (entry.branchId !== branchRef.current) {
            // store but only apply active branch
          }
          setTimeline((prev) => {
            if (prev.some((e) => e.eventId === entry.eventId && e.senderId === entry.senderId)) {
              return prev;
            }
            const next = [...prev, entry].sort((a, b) => a.seq - b.seq);
            const branchEntries = next.filter(
              (e) => e.branchId === branchRef.current,
            );
            void rebuildSnapshot(branchEntries, scrubSeq, authorFilter);
            return next;
          });
          break;
        }
        case "history_package": {
          if (String(msg.to_participant_id) !== s.participantId) return;
          const fromId = String(msg.from_participant_id);
          const sender = peersRef.current.find((p) => p.id === fromId);
          if (!sender) return;
          const plain = await crypto.openEnvelope(
            {
              id: sender.id,
              publicKeySpki: sender.public_key_spki,
              status: sender.status,
            },
            String(msg.iv_b64),
            String(msg.ciphertext_b64),
            String(msg.aad_json),
            `history:${msg.id}`,
          );
          if (!plain) return;
          const packed = JSON.parse(plain) as {
            entries: Array<{
              seq: number;
              event_id: string;
              sender_id: string;
              branch_id: string;
              event_json: string;
            }>;
            epoch?: number;
          };
          const restored: TimelineEntry[] = [];
          for (const e of packed.entries) {
            const event = await decodeEvent(e.event_json);
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
              [...prev, ...restored].map((x) => [`${x.senderId}:${x.eventId}`, x]),
            );
            const next = [...map.values()].sort((a, b) => a.seq - b.seq);
            void rebuildSnapshot(
              next.filter((e) => e.branchId === branchRef.current),
              scrubSeq,
              authorFilter,
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
        case "pong":
          break;
        default:
          break;
      }
    }

    async function sendHistoryPackage(target: Participant) {
      const s = sessionRef.current;
      const crypto = cryptoRef.current;
      if (!s || !crypto) return;
      const entries = timelineRef.current.filter(
        (e) => e.branchId === branchRef.current && e.event.t !== "cursor",
      );
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
        epoch: crypto.getEpoch(),
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
            status: "approved",
          },
        ],
      );
      const env = sealed[0];
      if (!env) return;
      const through = entries.reduce((m, e) => Math.max(m, e.seq), 0);
      send({
        type: "history_package",
        branch_id: branchRef.current,
        to_participant_id: target.id,
        through_seq: through,
        iv_b64: env.ivB64,
        ciphertext_b64: env.ciphertextB64,
        aad_json: env.aadJson,
      });
    }

    const ping = window.setInterval(() => {
      send({ type: "ping", ts: Date.now() });
    }, 20000);

    return () => {
      cancelled = true;
      window.clearInterval(ping);
      ws.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.roomId, session?.sessionToken]);

  useEffect(() => {
    const branchEntries = timeline.filter((e) => e.branchId === activeBranchId);
    void rebuildSnapshot(branchEntries, scrubSeq, authorFilter);
  }, [timeline, activeBranchId, scrubSeq, authorFilter, rebuildSnapshot]);

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
      const crypto = cryptoRef.current;
      if (crypto) setLocalEpoch(crypto.bumpEpoch());
    },
    [send],
  );
  const setLock = useCallback(
    (locked: boolean) => send({ type: "lock", locked }),
    [send],
  );

  const beginStroke = useCallback(
    async (id: string, color: string, width: number, tool: string) => {
      await publishEvent({ t: "stroke_begin", id, color, width, tool });
    },
    [publishEvent],
  );
  const addStrokePoints = useCallback(
    async (id: string, points: Point[]) => {
      const simplified = points.length > 8 ? await simplifyPoints(points, 1.2) : points;
      await publishEvent({ t: "stroke_points", id, points: simplified });
    },
    [publishEvent],
  );
  const endStroke = useCallback(
    async (id: string) => {
      await publishEvent({ t: "stroke_end", id });
    },
    [publishEvent],
  );
  const erase = useCallback(
    async (id: string, points: Point[], width: number) => {
      const simplified = points.length > 8 ? await simplifyPoints(points, 1.2) : points;
      await publishEvent({ t: "erase", id, points: simplified, width });
    },
    [publishEvent],
  );
  const clearBoard = useCallback(async () => {
    await publishEvent({ t: "clear", nonce: await randomId("clr") });
  }, [publishEvent]);
  const undo = useCallback(async () => {
    const target = snapshot.undo_stack.at(-1);
    if (target) await publishEvent({ t: "undo", target });
  }, [publishEvent, snapshot.undo_stack]);
  const redo = useCallback(async () => {
    const target = snapshot.redo_stack.at(-1);
    if (target) await publishEvent({ t: "redo", target });
  }, [publishEvent, snapshot.redo_stack]);
  const sendCursor = useCallback(
    async (x: number, y: number, visible: boolean) => {
      await publishEvent({ t: "cursor", x, y, visible });
    },
    [publishEvent],
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

  const maxSeq = useMemo(
    () =>
      timeline
        .filter((e) => e.branchId === activeBranchId)
        .reduce((m, e) => Math.max(m, e.seq), 0),
    [timeline, activeBranchId],
  );

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
    localEpoch,
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

function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const palette = ["#c41e3a", "#0033aa", "#0b5d1e", "#b36b00", "#6b2d8b", "#111"];
  return palette[h % palette.length]!;
}
