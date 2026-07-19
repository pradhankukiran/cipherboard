import { PROTOCOL_VERSION, type AadContext } from "./keys";

export type ParsedAad = {
  protocolVersion: number;
  roomId: string;
  senderId: string;
  recipientId: string;
  eventId: string;
  branchId: string;
};

/** Parse and canonicalize AAD JSON. Rejects unknown/missing fields. */
export function parseAadJson(aadJson: string): ParsedAad {
  let obj: unknown;
  try {
    obj = JSON.parse(aadJson);
  } catch {
    throw new Error("aad parse failed");
  }
  if (!obj || typeof obj !== "object") throw new Error("aad not object");
  const o = obj as Record<string, unknown>;
  const protocolVersion = o.v;
  const roomId = o.room;
  const senderId = o.from;
  const recipientId = o.to;
  const eventId = o.event;
  const branchId = o.branch;
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion)) {
    throw new Error("aad bad version");
  }
  if (
    typeof roomId !== "string" ||
    typeof senderId !== "string" ||
    typeof recipientId !== "string" ||
    typeof eventId !== "string" ||
    typeof branchId !== "string"
  ) {
    throw new Error("aad missing fields");
  }
  if (
    !roomId ||
    !senderId ||
    !recipientId ||
    !eventId ||
    !branchId ||
    roomId.length > 64 ||
    senderId.length > 64 ||
    recipientId.length > 64 ||
    eventId.length > 128 ||
    branchId.length > 64
  ) {
    throw new Error("aad field bounds");
  }
  return {
    protocolVersion,
    roomId,
    senderId,
    recipientId,
    eventId,
    branchId,
  };
}

export function assertAadMatches(
  aad: ParsedAad,
  expected: {
    roomId: string;
    senderId: string;
    recipientId: string;
    eventId: string;
    branchId: string;
  },
): void {
  if (aad.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("aad protocol mismatch");
  }
  if (aad.roomId !== expected.roomId) throw new Error("aad room mismatch");
  if (aad.senderId !== expected.senderId) throw new Error("aad sender mismatch");
  if (aad.recipientId !== expected.recipientId) {
    throw new Error("aad recipient mismatch");
  }
  if (aad.eventId !== expected.eventId) throw new Error("aad event mismatch");
  if (aad.branchId !== expected.branchId) throw new Error("aad branch mismatch");
}

export function aadContextFromParsed(a: ParsedAad): AadContext {
  return {
    protocolVersion: a.protocolVersion,
    roomId: a.roomId,
    senderId: a.senderId,
    recipientId: a.recipientId,
    eventId: a.eventId,
    branchId: a.branchId,
  };
}
