CREATE TABLE sso_identity_bindings (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  keystone_user_id TEXT NOT NULL UNIQUE,
  sso_username TEXT,
  sso_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, issuer, subject)
) STRICT;

-- A claim remains until success or safe cleanup. A crash requires operator
-- reconciliation rather than risking a duplicate Keystone user on retry.
CREATE TABLE sso_onboarding_claims (
  provider TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(provider, issuer, subject)
) STRICT;
