import {
  decryptFromSender,
  deriveMessageKey,
  encryptForRecipient,
  importPeerPublicKey,
  PROTOCOL_VERSION,
  type AadContext,
} from "./keys";

export type PeerInfo = {
  id: string;
  publicKeySpki: string;
  status: string;
};

/**
 * Manages pairwise message keys. On epoch bump (participant removed),
 * future keys are re-derived so removed members cannot decrypt new events.
 */
export class CryptoSession {
  private privateKey: CryptoKey;
  private roomId: string;
  private selfId: string;
  private epoch: number;
  private keyCache = new Map<string, CryptoKey>();
  private seenEventIds = new Set<string>();
  private maxSeen = 10_000;

  constructor(opts: {
    privateKey: CryptoKey;
    roomId: string;
    selfId: string;
    epoch: number;
  }) {
    this.privateKey = opts.privateKey;
    this.roomId = opts.roomId;
    this.selfId = opts.selfId;
    this.epoch = opts.epoch;
  }

  getEpoch(): number {
    return this.epoch;
  }

  /** Call when a participant is removed so future traffic uses new keys. */
  bumpEpoch(): number {
    this.epoch += 1;
    this.keyCache.clear();
    return this.epoch;
  }

  private cacheKey(peerId: string, direction: "send" | "recv"): string {
    return `${this.epoch}:${direction}:${peerId}`;
  }

  async getSendKey(peer: PeerInfo): Promise<CryptoKey> {
    const ck = this.cacheKey(peer.id, "send");
    const hit = this.keyCache.get(ck);
    if (hit) return hit;
    const pub = await importPeerPublicKey(peer.publicKeySpki);
    const key = await deriveMessageKey({
      privateKey: this.privateKey,
      peerPublicKey: pub,
      roomId: this.roomId,
      senderId: this.selfId,
      recipientId: peer.id,
      epoch: this.epoch,
    });
    this.keyCache.set(ck, key);
    return key;
  }

  async getRecvKey(peer: PeerInfo): Promise<CryptoKey> {
    const ck = this.cacheKey(peer.id, "recv");
    const hit = this.keyCache.get(ck);
    if (hit) return hit;
    const pub = await importPeerPublicKey(peer.publicKeySpki);
    const key = await deriveMessageKey({
      privateKey: this.privateKey,
      peerPublicKey: pub,
      roomId: this.roomId,
      senderId: peer.id,
      recipientId: this.selfId,
      epoch: this.epoch,
    });
    this.keyCache.set(ck, key);
    return key;
  }

  rememberEvent(eventId: string): boolean {
    if (this.seenEventIds.has(eventId)) return false;
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size > this.maxSeen) {
      const first = this.seenEventIds.values().next().value as string | undefined;
      if (first) this.seenEventIds.delete(first);
    }
    return true;
  }

  async sealForPeers(
    plaintext: string,
    eventId: string,
    branchId: string,
    peers: PeerInfo[],
  ): Promise<
    Array<{
      recipientId: string;
      ivB64: string;
      ciphertextB64: string;
      aadJson: string;
      protocolVersion: number;
    }>
  > {
    const pt = new TextEncoder().encode(plaintext);
    const out: Array<{
      recipientId: string;
      ivB64: string;
      ciphertextB64: string;
      aadJson: string;
      protocolVersion: number;
    }> = [];

    const recipients = peers.filter(
      (p) => p.status === "approved" && p.publicKeySpki.length > 0,
    );

    for (const peer of recipients) {
      const key = await this.getSendKey(peer);
      const aad: AadContext = {
        protocolVersion: PROTOCOL_VERSION,
        roomId: this.roomId,
        senderId: this.selfId,
        recipientId: peer.id,
        eventId,
        branchId,
      };
      const sealed = await encryptForRecipient(key, pt, aad);
      out.push({
        recipientId: peer.id,
        ivB64: sealed.ivB64,
        ciphertextB64: sealed.ciphertextB64,
        aadJson: sealed.aadJson,
        protocolVersion: PROTOCOL_VERSION,
      });
    }

    return out;
  }

  /**
   * Encrypt including a self-envelope when ownPublicSpki is provided.
   */
  async sealForPeersIncludingSelf(
    plaintext: string,
    eventId: string,
    branchId: string,
    peers: PeerInfo[],
    ownPublicSpki: string,
  ): Promise<
    Array<{
      recipientId: string;
      ivB64: string;
      ciphertextB64: string;
      aadJson: string;
      protocolVersion: number;
    }>
  > {
    const withSelf = [
      ...peers.filter((p) => p.status === "approved"),
      {
        id: this.selfId,
        publicKeySpki: ownPublicSpki,
        status: "approved",
      },
    ];
    // Dedupe by id
    const map = new Map(withSelf.map((p) => [p.id, p]));
    return this.sealForPeers(
      plaintext,
      eventId,
      branchId,
      [...map.values()],
    );
  }

  async openEnvelope(
    sender: PeerInfo,
    ivB64: string,
    ciphertextB64: string,
    aadJson: string,
    eventId: string,
  ): Promise<string | null> {
    if (!this.rememberEvent(`${sender.id}:${eventId}`)) {
      return null; // duplicate
    }
    const key = await this.getRecvKey(sender);
    const pt = await decryptFromSender(key, ivB64, ciphertextB64, aadJson);
    return new TextDecoder().decode(pt);
  }
}
