import { describe, expect, it } from "vitest";
import { assertAadMatches, parseAadJson } from "./aad";
import {
  decryptFromSender,
  deriveMessageKey,
  encryptForRecipient,
  fingerprintFromSpki,
  fingerprintFromSpkiB64,
  generateIdentity,
  importPeerPublicKey,
  verifyFingerprint,
  PROTOCOL_VERSION,
} from "./keys";
import { CryptoSession } from "./session";

describe("webcrypto e2e envelopes", () => {
  it("generates identity with fingerprint", async () => {
    const id = await generateIdentity();
    expect(id.publicKeySpkiB64.length).toBeGreaterThan(40);
    expect(id.fingerprint.split(" ").length).toBeGreaterThan(4);
    expect(id.privateKey.extractable).toBe(false);
    expect(await verifyFingerprint(id.publicKeySpkiB64, id.fingerprint)).toBe(
      true,
    );
  });

  it("roundtrips pairwise AES-GCM with AAD", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const bobPub = await importPeerPublicKey(bob.publicKeySpkiB64);
    const alicePub = await importPeerPublicKey(alice.publicKeySpkiB64);

    const sendKey = await deriveMessageKey({
      privateKey: alice.privateKey,
      peerPublicKey: bobPub,
      roomId: "rm_test",
      senderId: "alice",
      recipientId: "bob",
    });
    const recvKey = await deriveMessageKey({
      privateKey: bob.privateKey,
      peerPublicKey: alicePub,
      roomId: "rm_test",
      senderId: "alice",
      recipientId: "bob",
    });

    const plaintext = new TextEncoder().encode(
      JSON.stringify({ t: "stroke_end", id: "s1" }),
    );
    const aad = {
      protocolVersion: PROTOCOL_VERSION,
      roomId: "rm_test",
      senderId: "alice",
      recipientId: "bob",
      eventId: "ev1",
      branchId: "br1",
    };
    const sealed = await encryptForRecipient(sendKey, plaintext, aad);
    const opened = await decryptFromSender(
      recvKey,
      sealed.ivB64,
      sealed.ciphertextB64,
      sealed.aadJson,
    );
    expect(new TextDecoder().decode(opened)).toBe(
      new TextDecoder().decode(plaintext),
    );
  });

  it("validates aad against outer metadata before use", () => {
    const json = JSON.stringify({
      v: 1,
      room: "r",
      from: "a",
      to: "b",
      event: "e",
      branch: "br",
    });
    const aad = parseAadJson(json);
    expect(() =>
      assertAadMatches(aad, {
        roomId: "r",
        senderId: "a",
        recipientId: "b",
        eventId: "e",
        branchId: "br",
      }),
    ).not.toThrow();
    expect(() =>
      assertAadMatches(aad, {
        roomId: "r",
        senderId: "a",
        recipientId: "b",
        eventId: "OTHER",
        branchId: "br",
      }),
    ).toThrow();
  });

  it("marks seen only after successful decrypt", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const aliceSess = new CryptoSession({
      privateKey: alice.privateKey,
      roomId: "rm",
      selfId: "alice",
    });
    const bobSess = new CryptoSession({
      privateKey: bob.privateKey,
      roomId: "rm",
      selfId: "bob",
    });
    const sealed = await aliceSess.sealForPeers(
      "hello",
      "ev1",
      "br1",
      [
        {
          id: "bob",
          publicKeySpki: bob.publicKeySpkiB64,
          fingerprint: bob.fingerprint,
          status: "approved",
        },
      ],
    );
    const env = sealed[0]!;
    // forged aad should fail without consuming seen slot
    await expect(
      bobSess.openEnvelope({
        sender: {
          id: "alice",
          publicKeySpki: alice.publicKeySpkiB64,
          fingerprint: alice.fingerprint,
          status: "approved",
        },
        ivB64: env.ivB64,
        ciphertextB64: env.ciphertextB64,
        aadJson: env.aadJson.replace("ev1", "forged"),
        eventId: "ev1",
        branchId: "br1",
        recipientId: "bob",
      }),
    ).rejects.toBeTruthy();

    const ok = await bobSess.openEnvelope({
      sender: {
        id: "alice",
        publicKeySpki: alice.publicKeySpkiB64,
        fingerprint: alice.fingerprint,
        status: "approved",
      },
      ivB64: env.ivB64,
      ciphertextB64: env.ciphertextB64,
      aadJson: env.aadJson,
      eventId: "ev1",
      branchId: "br1",
      recipientId: "bob",
    });
    expect(ok).toBe("hello");
    const dup = await bobSess.openEnvelope({
      sender: {
        id: "alice",
        publicKeySpki: alice.publicKeySpkiB64,
        fingerprint: alice.fingerprint,
        status: "approved",
      },
      ivB64: env.ivB64,
      ciphertextB64: env.ciphertextB64,
      aadJson: env.aadJson,
      eventId: "ev1",
      branchId: "br1",
      recipientId: "bob",
    });
    expect(dup).toBeNull();
  });

  it("removed peer cannot open remaining pairwise traffic", async () => {
    const host = await generateIdentity();
    const guestA = await generateIdentity();
    const guestB = await generateIdentity();
    const hostSess = new CryptoSession({
      privateKey: host.privateKey,
      roomId: "rm",
      selfId: "host",
    });
    const aSess = new CryptoSession({
      privateKey: guestA.privateKey,
      roomId: "rm",
      selfId: "a",
    });
    const bSess = new CryptoSession({
      privateKey: guestB.privateKey,
      roomId: "rm",
      selfId: "b",
    });

    const toRemaining = await hostSess.sealForPeers(
      "after-remove",
      "ev2",
      "br",
      [
        {
          id: "a",
          publicKeySpki: guestA.publicKeySpkiB64,
          fingerprint: guestA.fingerprint,
          status: "approved",
        },
      ],
    );
    expect(toRemaining).toHaveLength(1);
    // guest B has no envelope
    expect(
      toRemaining.find((e) => e.recipientId === "b"),
    ).toBeUndefined();

    const opened = await aSess.openEnvelope({
      sender: {
        id: "host",
        publicKeySpki: host.publicKeySpkiB64,
        fingerprint: host.fingerprint,
        status: "approved",
      },
      ivB64: toRemaining[0]!.ivB64,
      ciphertextB64: toRemaining[0]!.ciphertextB64,
      aadJson: toRemaining[0]!.aadJson,
      eventId: "ev2",
      branchId: "br",
      recipientId: "a",
    });
    expect(opened).toBe("after-remove");

    // Even if B steals A's envelope ciphertext, AAD recipient binds to a
    await expect(
      bSess.openEnvelope({
        sender: {
          id: "host",
          publicKeySpki: host.publicKeySpkiB64,
          fingerprint: host.fingerprint,
          status: "approved",
        },
        ivB64: toRemaining[0]!.ivB64,
        ciphertextB64: toRemaining[0]!.ciphertextB64,
        aadJson: toRemaining[0]!.aadJson,
        eventId: "ev2",
        branchId: "br",
        recipientId: "b",
      }),
    ).rejects.toBeTruthy();
  });

  it("fingerprint stable for same SPKI", async () => {
    const id = await generateIdentity();
    const a = await fingerprintFromSpkiB64(id.publicKeySpkiB64);
    const b = await fingerprintFromSpkiB64(id.publicKeySpkiB64);
    expect(a).toBe(b);
    const spki = Uint8Array.from(atob(id.publicKeySpkiB64), (c) =>
      c.charCodeAt(0),
    );
    const c = await fingerprintFromSpki(spki.buffer);
    expect(c).toBe(a);
  });
});
