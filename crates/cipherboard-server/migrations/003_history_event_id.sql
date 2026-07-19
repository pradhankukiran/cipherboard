ALTER TABLE history_packages
    ADD COLUMN IF NOT EXISTS event_id TEXT;

UPDATE history_packages SET event_id = id WHERE event_id IS NULL;

ALTER TABLE history_packages
    ALTER COLUMN event_id SET NOT NULL;
