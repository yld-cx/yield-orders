CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  meta TEXT NOT NULL CHECK (json_valid(meta)),
  timestamp INTEGER NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  meta TEXT NOT NULL CHECK (json_valid(meta)),
  timestamp INTEGER NOT NULL
);

CREATE INDEX events_chain_block ON events(chain_id, block_number);
CREATE INDEX events_chain_time ON events(chain_id, timestamp DESC, id DESC);
CREATE INDEX events_chain_name_time ON events(chain_id, event_name, timestamp DESC, id DESC);

CREATE TABLE state (
  key TEXT PRIMARY KEY,
  meta TEXT NOT NULL CHECK (json_valid(meta)),
  timestamp INTEGER NOT NULL
);
