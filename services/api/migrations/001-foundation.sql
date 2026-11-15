CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS oauth_transactions (
  state_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  stream TEXT NOT NULL CHECK(stream IN ('edge','ios','android')),
  verifier_ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS connections (
  owner_id TEXT PRIMARY KEY,
  tokens_ciphertext TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS usage_sessions (
  owner_id TEXT NOT NULL,
  service TEXT NOT NULL,
  record_id TEXT NOT NULL,
  recorded_date TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(owner_id, service, record_id)
) STRICT;
CREATE INDEX IF NOT EXISTS usage_sessions_range ON usage_sessions(owner_id, service, recorded_date);
CREATE TABLE IF NOT EXISTS usage_windows (
  owner_id TEXT NOT NULL,
  service TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date_exclusive TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  skipped INTEGER NOT NULL,
  PRIMARY KEY(owner_id, service, start_date, end_date_exclusive)
) STRICT;
