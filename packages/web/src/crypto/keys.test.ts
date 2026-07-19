import { describe, expect, it } from "vitest";
import {
  decryptFromSender,
  deriveMessageKey,
  encryptForRecipient,
  fingerprintFromSpki,
  generateIdentity,
  importPeerPublicKey,
  PROTOCOL_VERSION,
} from "./keys";

describe("webcrypto e2e envelopes", () => {
  it("generates identity with fingerprint", async () => {
    const id = await generateIdentity();
    expect(id.publicKeySpkiB64.length).toBeGreaterThan(40);
    expect(id.fingerprint.split(" ").length).toBeGreaterThan(4);
    expect(id.privateKey.extractable).toBe(false);
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
      epoch: 0,
    });
    const recvKey = await deriveMessageKey({
      privateKey: bob.privateKey,
      peerPublicKey: alicePub,
      roomId: "rm_test",
      senderId: "alice",
      recipientId: "bob",
      epoch: 0,
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
    expect(sealed.ivB64.length).toBeGreaterThan(8);
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

  it("rejects wrong AAD", async () => {
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
      epoch: 0,
    });
    const recvKey = await deriveMessageKey({
      privateKey: bob.privateKey,
      peerPublicKey: alicePub,
      roomId: "rm_test",
      senderId: "alice",
      recipientId: "bob",
      epoch: 0,
    });
    const sealed = await encryptForRecipient(
      sendKey,
      new TextEncoder().encode("hi"),
      {
        protocolVersion: PROTOCOL_VERSION,
        roomId: "rm_test",
        senderId: "alice",
        recipientId: "bob",
        eventId: "ev1",
        branchId: "br1",
      },
    );
    await expect(
      decryptFromSender(
        recvKey,
        sealed.ivB64,
        sealed.ciphertextB64,
        sealed.aadJson.replace("ev1", "ev2"),
      ),
    ).rejects.toBeTruthy();
  });

  it("fingerprint stable for same SPKI", async () => {
    const id = await generateIdentity();
    const spki = Uint8Array.from(atob(id.publicKeySpkiB64), (c) =>
      c.charCodeAt(0),
    );
    const a = await fingerprintFromSpki(spki.buffer);
    const b = await fingerprintFromSpki(spki.buffer);
    expect(a).toBe(b);
  });
});
