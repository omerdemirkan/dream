-- The Apple Distribution certificate and private key Dream's own TestFlight builds sign with (one row, name
-- 'distribution'), sealed with the master key like `secrets`. Written by a granted build Mac, read only to release
-- it to the next one (http/Testflight.ts).
CREATE TABLE testflight_identity (
  name TEXT PRIMARY KEY,
  certificate_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  wrapped_key TEXT NOT NULL,
  key_nonce TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL
);
