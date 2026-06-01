-- Seed PA's unlimited Professional license. Idempotent.
INSERT OR IGNORE INTO licenses (
  license_key, tier, pack_size, issued_to_org, contact_email, issued_at, expires_at
) VALUES (
  'HRM-PRO-PA00-DOGF-OOD1',
  'professional',
  100,
  'Professional Advantage',
  'beau@professionaladvantage.com',
  strftime('%Y-%m-%dT%H:%M:%SZ','now'),
  NULL
);
