import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { CanvasBoard, exportPng } from "../components/CanvasBoard";
import { Participants } from "../components/Participants";
import { Timeline } from "../components/Timeline";
import { loadIdentity } from "../crypto/keystore";
import { COLORS } from "../lib/draw";
import { useRoom, type RoomSession } from "../hooks/useRoom";
import { identityCache } from "./LandingPage";

type Meta = {
  roomId: string;
  participantId: string;
  sessionToken: string;
  displayName: string;
  role: string;
  publicKeySpkiB64: string;
  fingerprint: string;
  branchId: string;
  inviteCode?: string;
  hostFingerprint?: string;
  hostPublicKeySpki?: string;
  epoch: number;
};

export function RoomPage() {
  const { roomId = "" } = useParams();
  const [session, setSession] = useState<RoomSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [color, setColor] = useState(COLORS[0]!);
  const [width, setWidth] = useState(3);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = sessionStorage.getItem(`cb:${roomId}`);
        const meta = raw ? (JSON.parse(raw) as Meta) : null;
        let privateKey = identityCache.get(roomId) ?? null;
        const stored = await loadIdentity(roomId);
        if (!privateKey && stored) privateKey = stored.privateKey;
        if (!meta || !privateKey) {
          setLoadError(
            "Missing local session keys. Create or join the room again from this browser.",
          );
          return;
        }
        if (cancelled) return;
        setSession({
          roomId: meta.roomId,
          participantId: meta.participantId,
          sessionToken: meta.sessionToken,
          displayName: meta.displayName,
          role: meta.role,
          publicKeySpkiB64: meta.publicKeySpkiB64,
          fingerprint: meta.fingerprint,
          privateKey,
          branchId: meta.branchId || stored?.inviteCode ? meta.branchId : meta.branchId,
          inviteCode: meta.inviteCode,
          epoch: meta.epoch ?? 0,
        });
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const room = useRoom(session);
  const isHost = session?.role === "host";
  const approved = room.myStatus === "approved";
  const scrubbing = room.scrubSeq !== null;

  const shareText = useMemo(() => {
    if (!session?.inviteCode) return "";
    return `${location.origin}/?join=${session.roomId}&code=${session.inviteCode}`;
  }, [session]);

  if (loadError) {
    return (
      <div className="app-shell">
        <TopBar />
        <main className="landing">
          <div className="error-box">{loadError}</div>
          <Link to="/">Back</Link>
        </main>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="app-shell">
        <TopBar status="connecting" />
        <main className="landing">
          <p className="muted">Loading session…</p>
        </main>
      </div>
    );
  }

  if (!approved) {
    const hostFp =
      room.participants.find((p) => p.role === "host")?.fingerprint ??
      (JSON.parse(sessionStorage.getItem(`cb:${roomId}`) || "{}") as Meta)
        .hostFingerprint;
    return (
      <div className="app-shell">
        <TopBar status={room.status} title="Waiting room" />
        <main className="waiting">
          <h2>Waiting for host approval</h2>
          <p className="muted">
            You are in the waiting room. The host must approve you before you can
            see or draw on the board.
          </p>
          <div className="panel stack">
            <div>
              <strong>Your safety code</strong>
              <div className="fingerprint">{session.fingerprint}</div>
            </div>
            {hostFp ? (
              <div>
                <strong>Host safety code (compare out-of-band)</strong>
                <div className="fingerprint">{hostFp}</div>
                <p className="muted">
                  Codes are not verified identity until you confirm them with the
                  host through a trusted channel.
                </p>
              </div>
            ) : null}
            <p>
              Status: <strong>{room.myStatus}</strong> · Connection:{" "}
              {room.status}
            </p>
            {room.myStatus === "rejected" ? (
              <div className="error-box">The host rejected your request.</div>
            ) : null}
            {room.error ? <div className="error-box">{room.error}</div> : null}
          </div>
          <Link to="/">Leave</Link>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TopBar
        status={room.status}
        title={session.displayName}
        subtitle={room.locked ? "room locked" : `epoch ${room.localEpoch}`}
      />
      <div className="board-layout">
        <div className="toolbar" role="toolbar" aria-label="Drawing tools">
          <button
            type="button"
            className={tool === "pen" ? "primary" : undefined}
            aria-pressed={tool === "pen"}
            onClick={() => setTool("pen")}
          >
            Pen
          </button>
          <button
            type="button"
            className={tool === "eraser" ? "primary" : undefined}
            aria-pressed={tool === "eraser"}
            onClick={() => setTool("eraser")}
          >
            Eraser
          </button>
          <span className="row" aria-label="Colors">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`color-swatch ${color === c ? "active" : ""}`}
                style={{ background: c }}
                aria-label={`Color ${c}`}
                aria-pressed={color === c}
                onClick={() => {
                  setColor(c);
                  setTool("pen");
                }}
              />
            ))}
          </span>
          <label className="row">
            Width
            <input
              type="range"
              min={1}
              max={24}
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
            />
          </label>
          <button type="button" onClick={() => void room.undo()} disabled={scrubbing}>
            Undo
          </button>
          <button type="button" onClick={() => void room.redo()} disabled={scrubbing}>
            Redo
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Clear the board for everyone on this branch?")) {
                void room.clearBoard();
              }
            }}
            disabled={scrubbing}
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => {
              const url = exportPng(room.snapshot);
              const a = document.createElement("a");
              a.href = url;
              a.download = `cipherboard-${session.roomId}.png`;
              a.click();
            }}
          >
            Export PNG
          </button>
          {isHost && session.inviteCode ? (
            <button
              type="button"
              onClick={async () => {
                const text = `Room: ${session.roomId}\nInvite: ${session.inviteCode}\n${shareText}`;
                await navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy invite"}
            </button>
          ) : null}
          {isHost ? (
            <button type="button" onClick={() => room.setLock(!room.locked)}>
              {room.locked ? "Unlock room" : "Lock room"}
            </button>
          ) : null}
        </div>

        <CanvasBoard
          snapshot={room.snapshot}
          cursors={room.cursors}
          tool={tool}
          color={color}
          width={width}
          disabled={scrubbing || room.status !== "open"}
          onBegin={(id, c, w, t) => void room.beginStroke(id, c, w, t)}
          onPoints={(id, pts) => void room.addStrokePoints(id, pts)}
          onEnd={(id) => void room.endStroke(id)}
          onErase={(id, pts, w) => void room.erase(id, pts, w)}
          onCursor={(x, y, v) => void room.sendCursor(x, y, v)}
        />

        <aside className="sidebar">
          <div className="stack">
            <div>
              <h3>Room</h3>
              <div className="fingerprint">{session.roomId}</div>
              {session.inviteCode ? (
                <p className="muted">Invite: {session.inviteCode}</p>
              ) : null}
            </div>
            <div>
              <h3>Your safety code</h3>
              <div className="fingerprint">{session.fingerprint}</div>
            </div>
            <div className="warn-box">
              Approved peers can screenshot. Encryption protects against the
              server, not endpoints.
            </div>
            {room.error ? <div className="error-box">{room.error}</div> : null}
          </div>
          <Participants
            participants={room.participants}
            selfId={session.participantId}
            isHost={!!isHost}
            onApprove={room.approve}
            onReject={room.reject}
            onRemove={room.remove}
          />
        </aside>

        <Timeline
          maxSeq={room.maxSeq}
          scrubSeq={room.scrubSeq}
          onScrub={room.setScrubSeq}
          authorFilter={room.authorFilter}
          onAuthorFilter={room.setAuthorFilter}
          participants={room.participants}
          branches={room.branches}
          activeBranchId={room.activeBranchId}
          onBranch={room.setActiveBranchId}
          onFork={(name, seq) => void room.forkBranch(name, seq)}
        />
      </div>
    </div>
  );
}
