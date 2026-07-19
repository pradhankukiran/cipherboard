export type CreateRoomResponse = {
  room_id: string;
  invite_code: string;
  participant_id: string;
  session_token: string;
  branch_id: string;
};

export type JoinRoomResponse = {
  room_id: string;
  participant_id: string;
  session_token: string;
  status: string;
  host_fingerprint: string;
  host_public_key_spki: string;
};

async function parseJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: string }).error)
        : res.statusText;
    throw new Error(msg || "request failed");
  }
  return body as T;
}

export async function createRoom(input: {
  displayName: string;
  publicKeySpki: string;
  fingerprint: string;
}): Promise<CreateRoomResponse> {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      display_name: input.displayName,
      public_key_spki: input.publicKeySpki,
      fingerprint: input.fingerprint,
    }),
  });
  return parseJson(res);
}

export async function joinRoom(input: {
  roomId: string;
  inviteCode: string;
  displayName: string;
  publicKeySpki: string;
  fingerprint: string;
}): Promise<JoinRoomResponse> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(input.roomId)}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      invite_code: input.inviteCode,
      display_name: input.displayName,
      public_key_spki: input.publicKeySpki,
      fingerprint: input.fingerprint,
    }),
  });
  return parseJson(res);
}

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

/** Sec-WebSocket-Protocol: fixed app protocol + auth.<hex-token> (not in URL). */
export function wsProtocols(sessionToken: string): string[] {
  return ["cipherboard", `auth.${sessionToken}`];
}

export function inviteShareUrl(roomId: string, inviteCode: string): string {
  return `${location.origin}/#join=${encodeURIComponent(roomId)}&code=${encodeURIComponent(inviteCode)}`;
}

export function readInviteFragment(): { roomId: string; code: string } | null {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const roomId = params.get("join");
  const code = params.get("code");
  // Clear fragment so invite secret does not linger in history/logs
  if (roomId || code) {
    history.replaceState(null, "", location.pathname + location.search);
  }
  if (roomId && code) return { roomId, code };
  return null;
}
