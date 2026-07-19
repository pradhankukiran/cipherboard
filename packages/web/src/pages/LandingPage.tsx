import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { generateIdentity } from "../crypto/keys";
import { saveIdentity } from "../crypto/keystore";
import { createRoom, joinRoom, readInviteFragment } from "../lib/api";
import { TopBar } from "../components/TopBar";
import { IconShield } from "../components/icons";

export function LandingPage() {
  const nav = useNavigate();
  const prefill = readInviteFragment();
  const [createName, setCreateName] = useState("");
  const [joinName, setJoinName] = useState("");
  const [roomId, setRoomId] = useState(prefill?.roomId ?? "");
  const [invite, setInvite] = useState(prefill?.code ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const hasInvitePrefill = Boolean(prefill?.roomId || prefill?.code);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy("create");
    try {
      const id = await generateIdentity();
      const displayName = createName.trim() || "Host";
      const res = await createRoom({
        displayName,
        publicKeySpki: id.publicKeySpkiB64,
        fingerprint: id.fingerprint,
      });
      const meta = {
        roomId: res.room_id,
        participantId: res.participant_id,
        sessionToken: res.session_token,
        displayName,
        role: "host",
        publicKeySpkiB64: id.publicKeySpkiB64,
        fingerprint: id.fingerprint,
        branchId: res.branch_id,
        inviteCode: res.invite_code,
      };
      await saveIdentity({
        roomId: res.room_id,
        participantId: res.participant_id,
        privateKey: id.privateKey,
        publicKey: id.publicKey,
        publicKeySpkiB64: id.publicKeySpkiB64,
        fingerprint: id.fingerprint,
        displayName,
        sessionToken: res.session_token,
        role: "host",
        inviteCode: res.invite_code,
        branchId: res.branch_id,
      });
      sessionStorage.setItem(`cb:${res.room_id}`, JSON.stringify(meta));
      identityCache.set(res.room_id, id.privateKey);
      nav(`/room/${res.room_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onJoin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy("join");
    try {
      const id = await generateIdentity();
      const displayName = joinName.trim() || "Guest";
      const res = await joinRoom({
        roomId: roomId.trim(),
        inviteCode: invite.trim(),
        displayName,
        publicKeySpki: id.publicKeySpkiB64,
        fingerprint: id.fingerprint,
      });
      const meta = {
        roomId: res.room_id,
        participantId: res.participant_id,
        sessionToken: res.session_token,
        displayName,
        role: "guest",
        publicKeySpkiB64: id.publicKeySpkiB64,
        fingerprint: id.fingerprint,
        branchId: "",
        hostFingerprint: res.host_fingerprint,
        hostPublicKeySpki: res.host_public_key_spki,
      };
      await saveIdentity({
        roomId: res.room_id,
        participantId: res.participant_id,
        privateKey: id.privateKey,
        publicKey: id.publicKey,
        publicKeySpkiB64: id.publicKeySpkiB64,
        fingerprint: id.fingerprint,
        displayName,
        sessionToken: res.session_token,
        role: "guest",
        hostFingerprint: res.host_fingerprint,
        hostPublicKeySpki: res.host_public_key_spki,
      });
      sessionStorage.setItem(`cb:${res.room_id}`, JSON.stringify(meta));
      identityCache.set(res.room_id, id.privateKey);
      nav(`/room/${res.room_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="app-shell">
      <TopBar />
      <main className="landing" id="main">
        <header className="landing-hero">
          <p className="eyebrow">Encrypted instruction board</p>
          <h2>Secure whiteboard for live teaching</h2>
          <p className="lede">
            Host small encrypted board sessions with your class. Drawing keys stay
            in the browser; the server only relays ciphertext.
          </p>
        </header>

        <aside className="landing-trust" aria-label="How trust works">
          <h3>
            <IconShield className="icon-sm" /> Trust model
          </h3>
          <ul>
            <li>
              End-to-end encryption with non-extractable keys in your browser.
            </li>
            <li>Rooms hold up to 8 people; hosts approve every join.</li>
            <li>
              Compare safety codes out-of-band before treating a peer as verified.
            </li>
            <li>
              Encryption hides board content from the server — not screenshots by
              approved participants.
            </li>
          </ul>
        </aside>

        {error ? (
          <div className="error-box" role="alert">
            {error}
          </div>
        ) : null}

        <div className="landing-paths">
          <form
            className={`landing-card${hasInvitePrefill ? "" : " primary-path"}`}
            onSubmit={onCreate}
            aria-labelledby="create-heading"
          >
            <div className="landing-card-header">
              <h3 id="create-heading">Create secure room</h3>
              <p>Start a session as host. You control invites and approvals.</p>
            </div>
            <div className="field">
              <label htmlFor="create-name">Display name</label>
              <input
                id="create-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                maxLength={64}
                autoComplete="nickname"
                placeholder="e.g. Dr. Rivera"
                required
                disabled={busy !== null}
              />
            </div>
            <div className="actions">
              <button
                className={hasInvitePrefill ? undefined : "primary"}
                type="submit"
                disabled={busy !== null}
              >
                {busy === "create" ? "Creating…" : "Create room"}
              </button>
            </div>
          </form>

          <form
            className={`landing-card${hasInvitePrefill ? " primary-path" : ""}`}
            onSubmit={onJoin}
            aria-labelledby="join-heading"
          >
            <div className="landing-card-header">
              <h3 id="join-heading">Join with invite</h3>
              <p>
                {hasInvitePrefill
                  ? "Invite details were filled from your link. Confirm your name and request access."
                  : "Enter the room ID and invite code from your instructor."}
              </p>
            </div>
            <div className="field">
              <label htmlFor="join-name">Display name</label>
              <input
                id="join-name"
                value={joinName}
                onChange={(e) => setJoinName(e.target.value)}
                maxLength={64}
                autoComplete="nickname"
                placeholder="e.g. Alex"
                required
                disabled={busy !== null}
                autoFocus={hasInvitePrefill}
              />
            </div>
            <div className="field">
              <label htmlFor="room-id">Room ID</label>
              <input
                id="room-id"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
                disabled={busy !== null}
              />
            </div>
            <div className="field">
              <label htmlFor="invite">Invite code</label>
              <input
                id="invite"
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
                disabled={busy !== null}
              />
            </div>
            <div className="actions">
              <button
                className={hasInvitePrefill ? "primary" : undefined}
                type="submit"
                disabled={busy !== null}
              >
                {busy === "join" ? "Requesting…" : "Request access"}
              </button>
            </div>
          </form>
        </div>

        <p className="landing-footnote">
          Safety codes are cryptographic fingerprints, not proof of real-world
          identity until you verify them through a channel you trust.
        </p>
      </main>
    </div>
  );
}

export const identityCache = new Map<string, CryptoKey>();
