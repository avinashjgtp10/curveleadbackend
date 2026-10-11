-- Photos, documents and videos on sequence steps. One file per step:
-- [{ "url": "...", "name": "brochure.pdf", "type": "image|video|document", "size": 123, "mime": "..." }]
ALTER TABLE automation_sequence_steps ADD COLUMN IF NOT EXISTS media JSONB NOT NULL DEFAULT '[]';
