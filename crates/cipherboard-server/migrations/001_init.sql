-- Cipherboard schema: rooms, participants, ciphertext envelopes, branches, snapshots.
-- Server stores ciphertext + routing metadata only. No plaintext board content.

CREATE TABLE IF NOT EXISTS rooms (
    id              TEXT PRIMARY KEY,
    invite_code_hash TEXT NOT NULL,
    host_participant_id TEXT NOT NULL,
    locked          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rooms_created ON rooms (created_at DESC);

CREATE TABLE IF NOT EXISTS participants (
    id              TEXT PRIMARY KEY,
    room_id         TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    display_name    TEXT NOT NULL,
    public_key_spki TEXT NOT NULL,
    fingerprint     TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('host', 'guest')),
    status          TEXT NOT NULL CHECK (status IN ('waiting', 'approved', 'rejected', 'removed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (room_id, id)
);

CREATE INDEX IF NOT EXISTS idx_participants_room ON participants (room_id, status);

CREATE TABLE IF NOT EXISTS branches (
    id              TEXT PRIMARY KEY,
    room_id         TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    parent_branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
    fork_seq        BIGINT,
    created_by      TEXT REFERENCES participants(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branches_room ON branches (room_id);

CREATE TABLE IF NOT EXISTS envelopes (
    id              BIGSERIAL PRIMARY KEY,
    room_id         TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    branch_id       TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    event_id        TEXT NOT NULL,
    sender_id       TEXT NOT NULL,
    recipient_id    TEXT NOT NULL,
    seq             BIGINT NOT NULL,
    protocol_version INT NOT NULL DEFAULT 1,
    iv_b64          TEXT NOT NULL,
    ciphertext_b64  TEXT NOT NULL,
    aad_json        TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (room_id, branch_id, event_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_envelopes_room_branch_seq
    ON envelopes (room_id, branch_id, seq);
CREATE INDEX IF NOT EXISTS idx_envelopes_recipient
    ON envelopes (room_id, recipient_id, seq);

CREATE TABLE IF NOT EXISTS history_packages (
    id              TEXT PRIMARY KEY,
    room_id         TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    branch_id       TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    from_participant_id TEXT NOT NULL,
    to_participant_id   TEXT NOT NULL,
    through_seq     BIGINT NOT NULL,
    iv_b64          TEXT NOT NULL,
    ciphertext_b64  TEXT NOT NULL,
    aad_json        TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_history_to
    ON history_packages (room_id, to_participant_id);
