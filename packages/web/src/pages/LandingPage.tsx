import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { generateIdentity } from "../crypto/keys";
import { saveIdentity } from "../crypto/keystore";
import { createRoom, joinRoom, readInviteFragment } from "../lib/api";
import { TopBar } from "../components/TopBar";

export function LandingPage() {
  const nav = useNavigate();
  const prefill = readInviteFragment();
  const [name, setName] = useState("");
  const [roomId, setRoomId] = useState(prefill?.roomId ?? "");
  const [invite, setInvite] = useState(prefill?.code ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const id = await generateIdentity();
      const res = await createRoom({
        displayName: name.trim() || "Host",
        publicKeySpki: id.publicKeySpkiB64,
        fingerprint: id.fingerprint,
      });
      const meta = {
        roomId: res.room_id,
        participantId: res.participant_id,
        sessionToken: res.session_token,
        displayName: name.trim() || "Host",
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
        displayName: meta.displayName,
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
      setBusy(false);
    }
  }

  async function onJoin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const id = await generateIdentity();
      const res = await joinRoom({
        roomId: roomId.trim(),
        inviteCode: invite.trim(),
        displayName: name.trim() || "Guest",
        publicKeySpki: id.publicKeySpkiB64,
        fingerprint: id.fingerprint,
      });
      const meta = {
        roomId: res.room_id,
        participantId: res.participant_id,
        sessionToken: res.session_token,
        displayName: name.trim() || "Guest",
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
        displayName: meta.displayName,
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
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <TopBar />
      <main className="landing">
        <div>
          <h2>End-to-end encrypted whiteboard</h2>
          <p className="muted">
            Small rooms (up to 8). The server only relays ciphertext. Private keys
            stay in your browser as non-extractable WebCrypto keys.
          </p>
        </div>

        <div className="warn-box" role="note">
          Encryption hides board content from the server and network observers. It
          does not stop approved participants from screenshotting or recording.
          Compare safety codes out-of-band before trusting a peer — codes are not
          proof of real-world identity until you verify them.
        </div>

        {error ? (
          <div className="error-box" role="alert">
            {error}
          </div>
        ) : null}

        <form className="panel stack" onSubmit={onCreate}>
          <h3 style={{ margin: 0 }}>Create a room</h3>
          <div className="field">
            <label htmlFor="create-name">Display name</label>
            <input
              id="create-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              autoComplete="nickname"
              required
            />
          </div>
          <button className="primary" type="submit" disabled={busy}>
            Create room
          </button>
        </form>

        <form className="panel stack" onSubmit={onJoin}>
          <h3 style={{ margin: 0 }}>Join a room</h3>
          <div className="field">
            <label htmlFor="join-name">Display name</label>
            <input
              id="join-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              autoComplete="nickname"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="room-id">Room ID</label>
            <input
              id="room-id"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="invite">Invite code</label>
            <input
              id="invite"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              required
            />
          </div>
          <button type="submit" disabled={busy}>
            Request access
          </button>
        </form>
      </main>
    </div>
  );
}

export const identityCache = new Map<string, CryptoKey>();
