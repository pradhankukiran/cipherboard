import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { CanvasBoard, exportPng } from "../components/CanvasBoard";
import { Participants } from "../components/Participants";
import { Timeline } from "../components/Timeline";
import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconEraser,
  IconLock,
  IconPen,
  IconRedo,
  IconShield,
  IconTrash,
  IconUndo,
  IconUnlock,
} from "../components/icons";
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

function connectionLabel(status: string): string {
  if (status === "connecting") return "reconnecting";
  return status;
}

export function RoomPage() {
  const { roomId = "" } = useParams();
  const [session, setSession] = useState<RoomSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [color, setColor] = useState(COLORS[0]!);
  const [width, setWidth] = useState(3);
  const [copied, setCopied] = useState(false);
  const [hostFp, setHostFp] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = sessionStorage.getItem(`cb:${roomId}`);
        const meta = raw ? (JSON.parse(raw) as Meta) : null;
        const stored = await loadIdentity(roomId);
        const privateKey = identityCache.get(roomId) ?? stored?.privateKey ?? null;

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
  const canvasDisabled = scrubbing || room.status !== "open";

  const shareText = useMemo(() => {
    if (!session?.inviteCode) return "";
    return inviteShareUrl(session.roomId, session.inviteCode);
  }, [session]);

  async function copyInvite() {
    if (!session?.inviteCode) return;
    const text = `Room: ${session.roomId}\nInvite: ${session.inviteCode}\n${shareText}`;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  }

  if (loadError) {
    return (
      <div className="app-shell">
        <TopBar />
        <main className="page-center" id="main">
          <div className="error-box" role="alert">
            {loadError}
          </div>
          <div className="page-actions">
            <Link className="btn-link" to="/">
              Back to home
            </Link>
          </div>
        </main>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="app-shell">
        <TopBar status="connecting" />
        <main className="page-center" id="main" aria-busy="true">
          <p className="muted">Loading session…</p>
        </main>
      </div>
    );
  }

  if (!approved) {
    const displayHostFp =
      room.participants.find((p) => p.role === "host")?.fingerprint ?? hostFp;
    const waitState =
      room.myStatus === "rejected"
        ? "rejected"
        : room.error
          ? "error"
          : room.myStatus === "approved"
            ? "approved"
            : "waiting";

    return (
      <div className="app-shell">
        <TopBar status={room.status} title="Waiting room" />
        <main className="waiting" id="main">
          <header className="waiting-header">
            <h2>Waiting for host approval</h2>
            <p className="muted">
              You are in the waiting room. The host must approve you before you can
              see or draw on the board.
            </p>
          </header>

          <div
            className="waiting-progress"
            data-state={waitState}
            role="status"
            aria-live="polite"
          >
            <span className="waiting-progress-pulse" aria-hidden />
            <div>
              <strong>
                {room.myStatus === "rejected"
                  ? "Access rejected"
                  : room.myStatus === "waiting"
                    ? "Approval pending"
                    : `Status: ${room.myStatus}`}
              </strong>
              <div className="muted">
                Connection: {connectionLabel(room.status)}
              </div>
            </div>
          </div>

          <div className="waiting-codes">
            <div className="waiting-code-block">
              <strong>Your safety code</strong>
              <div className="fingerprint">{session.fingerprint}</div>
              <p className="muted">
                Share this with the host if they ask you to verify identity.
              </p>
            </div>
            {displayHostFp ? (
              <div className="waiting-code-block">
                <strong>Host safety code (compare out-of-band)</strong>
                <div className="fingerprint">{displayHostFp}</div>
                <p className="muted">
                  Codes are not verified identity until you confirm them with the
                  host through a trusted channel.
                </p>
              </div>
            ) : null}
          </div>

          {room.myStatus === "rejected" ? (
            <div className="error-box" role="alert">
              The host rejected your request.
            </div>
          ) : null}
          {room.error ? (
            <div className="error-box" role="alert">
              {room.error}
            </div>
          ) : null}

          <div className="waiting-actions">
            <Link className="btn-link" to="/">
              Leave
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const canvasStatus = scrubbing
    ? "Viewing history — drawing paused"
    : room.status === "connecting"
      ? "Reconnecting…"
      : room.status !== "open"
        ? "Disconnected — drawing paused"
        : room.locked
          ? "Room locked"
          : null;

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
      <main className="board-layout" id="main">
        <div className="toolbar" role="toolbar" aria-label="Drawing tools">
          <div className="toolbar-group" role="group" aria-label="Tool">
            <button
              type="button"
              className={tool === "pen" ? "primary" : undefined}
              aria-pressed={tool === "pen"}
              onClick={() => setTool("pen")}
            >
              <IconPen />
              Pen
            </button>
            <button
              type="button"
              className={tool === "eraser" ? "primary" : undefined}
              aria-pressed={tool === "eraser"}
              onClick={() => setTool("eraser")}
            >
              <IconEraser />
              Eraser
            </button>
          </div>

          <div className="toolbar-group" role="group" aria-label="Colors">
            <span className="toolbar-group-label">Color</span>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`color-swatch${color === c ? " active" : ""}`}
                style={{ "--swatch": c } as CSSProperties}
                aria-label={`Color ${c}`}
                aria-pressed={color === c}
                onClick={() => {
                  setColor(c);
                  setTool("pen");
                }}
              />
            ))}
          </div>

          <div className="toolbar-group" role="group" aria-label="Stroke width">
            <label className="toolbar-width">
              Width
              <input
                type="range"
                min={1}
                max={24}
                value={width}
                aria-valuemin={1}
                aria-valuemax={24}
                aria-valuenow={width}
                onChange={(e) => setWidth(Number(e.target.value))}
              />
              <span className="muted" aria-hidden>
                {width}
              </span>
            </label>
          </div>

          <div className="toolbar-group" role="group" aria-label="Edit history">
            <button
              type="button"
              onClick={() => void room.undo()}
              disabled={scrubbing}
            >
              <IconUndo />
              Undo
            </button>
            <button
              type="button"
              onClick={() => void room.redo()}
              disabled={scrubbing}
            >
              <IconRedo />
              Redo
            </button>
          </div>

          <div className="toolbar-group" role="group" aria-label="Board">
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (window.confirm("Clear the board for everyone on this branch?")) {
                  void room.clearBoard();
                }
              }}
              disabled={scrubbing}
            >
              <IconTrash />
              Clear
            </button>
          </div>

          <div className="toolbar-group toolbar-group-end" role="group" aria-label="Room actions">
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
              <IconDownload />
              Export PNG
            </button>
            {isHost && session.inviteCode ? (
              <button type="button" onClick={() => void copyInvite()}>
                {copied ? <IconCheck /> : <IconCopy />}
                {copied ? "Copied" : "Copy invite"}
              </button>
            ) : null}
            {isHost ? (
              <button type="button" onClick={() => room.setLock(!room.locked)}>
                {room.locked ? <IconUnlock /> : <IconLock />}
                {room.locked ? "Unlock room" : "Lock room"}
              </button>
            ) : null}
          </div>
        </div>

        <CanvasBoard
          snapshot={room.snapshot}
          cursors={room.cursors}
          tool={tool}
          color={color}
          width={width}
          disabled={canvasDisabled}
          statusMessage={canvasStatus}
          onBegin={(id, c, w, t) => void room.beginStroke(id, c, w, t)}
          onPoints={(id, pts) => void room.addStrokePoints(id, pts)}
          onEnd={(id) => void room.endStroke(id)}
          onErase={(id, pts, w) => void room.erase(id, pts, w)}
          onCursor={(x, y, v) => void room.sendCursor(x, y, v)}
        />

        <aside className="sidebar" aria-label="Room details">
          <section className="sidebar-section" aria-label="Room identity">
            <h3>
              <IconShield className="icon-sm" /> Room
            </h3>
            <div className="sidebar-id">
              <span className="label">Room ID</span>
              <div className="fingerprint">{session.roomId}</div>
            </div>
            {session.inviteCode ? (
              <div className="sidebar-id">
                <span className="label">Invite</span>
                <div className="fingerprint">Invite: {session.inviteCode}</div>
              </div>
            ) : null}
            <div className="sidebar-id">
              <span className="label">Your safety code</span>
              <div className="fingerprint">{session.fingerprint}</div>
            </div>
            {room.locked ? (
              <div className="warn-box" role="status">
                Room is locked. New participants cannot join until unlocked.
              </div>
            ) : null}
            <p className="sidebar-caveat">
              Server cannot read the board. Approved peers can still screenshot.
              Compare safety codes out of band.
            </p>
            {room.error ? (
              <div className="error-box" role="alert">
                {room.error}
              </div>
            ) : null}
          </section>

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
      </main>
    </div>
  );
}
