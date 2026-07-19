import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { CanvasBoard, exportPng } from "../components/CanvasBoard";
import { Participants } from "../components/Participants";
import { Timeline } from "../components/Timeline";
import { loadIdentity } from "../crypto/keystore";
import { fingerprintFromSpkiB64, verifyFingerprint } from "../crypto/keys";
import { COLORS } from "../lib/draw";
import { inviteShareUrl } from "../lib/api";
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
};

export function RoomPage() {
  const { roomId = "" } = useParams();
  const [session, setSession] = useState<RoomSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [color, setColor] = useState(COLORS[0]!);
  const [width, setWidth] = useState(3);
  const [copied, setCopied] = useState(false);
  const [hostFp, setHostFp] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = sessionStorage.getItem(`cb:${roomId}`);
        const meta = raw ? (JSON.parse(raw) as Meta) : null;
        const stored = await loadIdentity(roomId);
        let privateKey = identityCache.get(roomId) ?? stored?.privateKey ?? null;

        const resolved: Meta | null = meta
          ? meta
          : stored
            ? {
                roomId: stored.roomId,
                participantId: stored.participantId,
                sessionToken: stored.sessionToken,
                displayName: stored.displayName,
                role: stored.role,
                publicKeySpkiB64: stored.publicKeySpkiB64,
                fingerprint: stored.fingerprint,
                branchId: stored.branchId ?? "",
                inviteCode: stored.inviteCode,
                hostFingerprint: stored.hostFingerprint,
                hostPublicKeySpki: stored.hostPublicKeySpki,
              }
            : null;

        if (!resolved || !privateKey) {
          setLoadError(
            "Missing local session keys. Create or join the room again from this browser.",
          );
          return;
        }

        const fpOk = await verifyFingerprint(
          resolved.publicKeySpkiB64,
          resolved.fingerprint,
        );
        if (!fpOk) {
          const recomputed = await fingerprintFromSpkiB64(resolved.publicKeySpkiB64);
          resolved.fingerprint = recomputed;
        }

        if (resolved.hostPublicKeySpki) {
          const hfp = await fingerprintFromSpkiB64(resolved.hostPublicKeySpki);
          if (
            resolved.hostFingerprint &&
            !(await verifyFingerprint(
              resolved.hostPublicKeySpki,
              resolved.hostFingerprint,
            ))
          ) {
            setLoadError("Host key fingerprint mismatch — possible key substitution.");
            return;
          }
          if (!cancelled) setHostFp(hfp);
        } else if (resolved.hostFingerprint) {
          if (!cancelled) setHostFp(resolved.hostFingerprint);
        }

        if (cancelled) return;
        setSession({
          roomId: resolved.roomId,
          participantId: resolved.participantId,
          sessionToken: resolved.sessionToken,
          displayName: resolved.displayName,
          role: resolved.role,
          publicKeySpkiB64: resolved.publicKeySpkiB64,
          fingerprint: resolved.fingerprint,
          privateKey,
          branchId: resolved.branchId,
          inviteCode: resolved.inviteCode,
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
    return inviteShareUrl(session.roomId, session.inviteCode);
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
    const displayHostFp =
      room.participants.find((p) => p.role === "host")?.fingerprint ?? hostFp;
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
            {displayHostFp ? (
              <div>
                <strong>Host safety code (compare out-of-band)</strong>
                <div className="fingerprint">{displayHostFp}</div>
                <p className="muted">
                  Codes are not verified identity until you confirm them with the
                  host through a trusted channel.
                </p>
              </div>
            ) : null}
            <p>
              Status: <strong>{room.myStatus}</strong> · Connection:{" "}
              {room.status === "connecting" ? "reconnecting" : room.status}
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
        subtitle={
          room.locked
            ? "room locked"
            : room.status === "connecting"
              ? "reconnecting"
              : "encrypted"
        }
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
              server, not endpoints. Safety codes are not verified identity until
              compared out of band.
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
