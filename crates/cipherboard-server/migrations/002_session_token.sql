ALTER TABLE participants
    ADD COLUMN IF NOT EXISTS session_token_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_participants_session
    ON participants (session_token_hash)
    WHERE session_token_hash IS NOT NULL;
