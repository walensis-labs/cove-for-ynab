CREATE TABLE IF NOT EXISTS ledger_records (
  id TEXT PRIMARY KEY,
  recorded_at TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  cutoff TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'close',
  account TEXT NOT NULL,
  record TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_records_plan_kind_account
  ON ledger_records (plan_id, kind, account);

CREATE TABLE IF NOT EXISTS monitor_state (
  card_key TEXT PRIMARY KEY,
  last_gap_milli INTEGER,
  last_alert_signature TEXT,
  last_budgeted_milli INTEGER,
  last_month TEXT,
  updated_at TEXT
);
