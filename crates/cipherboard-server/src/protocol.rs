use serde::{Deserialize, Serialize};

/// Client → server messages. Server never sees plaintext board content.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Hello {
        participant_id: String,
        room_id: String,
        session_token: String,
    },
    RequestJoin {
        // unused over WS after REST join; kept for protocol completeness
    },
    Approve {
        target_id: String,
    },
    Reject {
        target_id: String,
    },
    Remove {
        target_id: String,
    },
    Lock {
        locked: bool,
    },
    /// Per-recipient ciphertext envelopes for one logical event.
    RelayEnvelopes {
        branch_id: String,
        event_id: String,
        seq_hint: Option<u64>,
        envelopes: Vec<EnvelopeWire>,
    },
    /// Encrypted history package for a newly approved participant.
    HistoryPackage {
        branch_id: String,
        to_participant_id: String,
        through_seq: u64,
        iv_b64: String,
        ciphertext_b64: String,
        aad_json: String,
    },
    CreateBranch {
        name: String,
        parent_branch_id: String,
        fork_seq: u64,
    },
    Ping {
        ts: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvelopeWire {
    pub recipient_id: String,
    pub iv_b64: String,
    pub ciphertext_b64: String,
    pub aad_json: String,
    pub protocol_version: i32,
}

/// Server → client messages.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Welcome {
        participant_id: String,
        room_id: String,
        role: String,
        status: String,
        branch_id: String,
    },
    Error {
        code: String,
        message: String,
    },
    RoomState {
        locked: bool,
        participants: Vec<ParticipantPublic>,
        branches: Vec<BranchPublic>,
    },
    ParticipantUpdated {
        participant: ParticipantPublic,
    },
    Envelope {
        room_id: String,
        branch_id: String,
        event_id: String,
        sender_id: String,
        recipient_id: String,
        seq: u64,
        protocol_version: i32,
        iv_b64: String,
        ciphertext_b64: String,
        aad_json: String,
    },
    HistoryPackage {
        id: String,
        branch_id: String,
        from_participant_id: String,
        to_participant_id: String,
        through_seq: u64,
        iv_b64: String,
        ciphertext_b64: String,
        aad_json: String,
    },
    BranchCreated {
        branch: BranchPublic,
    },
    Pong {
        ts: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParticipantPublic {
    pub id: String,
    pub display_name: String,
    pub public_key_spki: String,
    pub fingerprint: String,
    pub role: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchPublic {
    pub id: String,
    pub name: String,
    pub parent_branch_id: Option<String>,
    pub fork_seq: Option<u64>,
}
