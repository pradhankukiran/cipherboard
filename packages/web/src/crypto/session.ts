import { assertAadMatches, parseAadJson } from "./aad";
import {
  decryptFromSender,
  deriveMessageKey,
  encryptForRecipient,
  importPeerPublicKey,
  verifyFingerprint,
  PROTOCOL_VERSION,
  type AadContext,
} from "./keys";

export type PeerInfo = {
  id: string;
  publicKeySpki: string;
  fingerprint: string;
  status: string;
};

/**
 * Pairwise message keys via ECDH + HKDF. Removed peers are simply excluded
 * from recipient lists; they cannot derive remaining pairs' secrets.
 */
export class CryptoSession {
  private privateKey: CryptoKey;
  private roomId: string;
  private selfId: string;
  private keyCache = new Map<string, CryptoKey>();
  private seenEventIds = new Set<string>();
  private maxSeen = 10_000;

  constructor(opts: {
    privateKey: CryptoKey;
    roomId: string;
    selfId: string;
  }) {
    this.privateKey = opts.privateKey;
    this.roomId = opts.roomId;
    this.selfId = opts.selfId;
  }

  private cacheKey(peerId: string, direction: "send" | "recv"): string {
    return `${direction}:${peerId}`;
  }

  async getSendKey(peer: PeerInfo): Promise<CryptoKey> {
    await this.assertPeerKey(peer);
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
    });
    this.keyCache.set(ck, key);
    return key;
  }

  async getRecvKey(peer: PeerInfo): Promise<CryptoKey> {
    await this.assertPeerKey(peer);
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
    });
    this.keyCache.set(ck, key);
    return key;
  }

  private async assertPeerKey(peer: PeerInfo): Promise<void> {
    if (!peer.publicKeySpki) throw new Error("missing peer key");
    const ok = await verifyFingerprint(peer.publicKeySpki, peer.fingerprint);
    if (!ok) throw new Error("peer fingerprint mismatch");
  }

  dropPeerKeys(peerId: string): void {
    this.keyCache.delete(this.cacheKey(peerId, "send"));
    this.keyCache.delete(this.cacheKey(peerId, "recv"));
  }

  hasSeen(eventKey: string): boolean {
    return this.seenEventIds.has(eventKey);
  }

  markSeen(eventKey: string): void {
    this.seenEventIds.add(eventKey);
    if (this.seenEventIds.size > this.maxSeen) {
      const first = this.seenEventIds.values().next().value as string | undefined;
      if (first) this.seenEventIds.delete(first);
    }
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

  async sealForPeersIncludingSelf(
    plaintext: string,
    eventId: string,
    branchId: string,
    peers: PeerInfo[],
    ownPublicSpki: string,
    ownFingerprint: string,
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
        fingerprint: ownFingerprint,
        status: "approved",
      },
    ];
    const map = new Map(withSelf.map((p) => [p.id, p]));
    return this.sealForPeers(plaintext, eventId, branchId, [...map.values()]);
  }

  /**
   * Validate outer metadata against AAD, then decrypt. Seen-mark only after success.
   */
  async openEnvelope(params: {
    sender: PeerInfo;
    ivB64: string;
    ciphertextB64: string;
    aadJson: string;
    eventId: string;
    branchId: string;
    recipientId: string;
  }): Promise<string | null> {
    const eventKey = `${params.sender.id}:${params.eventId}:${params.recipientId}`;
    if (this.hasSeen(eventKey)) return null;

    const aad = parseAadJson(params.aadJson);
    assertAadMatches(aad, {
      roomId: this.roomId,
      senderId: params.sender.id,
      recipientId: params.recipientId,
      eventId: params.eventId,
      branchId: params.branchId,
    });

    const key = await this.getRecvKey(params.sender);
    const pt = await decryptFromSender(
      key,
      params.ivB64,
      params.ciphertextB64,
      params.aadJson,
    );
    this.markSeen(eventKey);
    return new TextDecoder().decode(pt);
  }
}
