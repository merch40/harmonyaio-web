# harmony-license-worker

Cloudflare Worker + D1 service that issues, validates, and revokes
**Harmony AIO** license blobs.  Talks to `internal/license/` on the
Harmony Go server.  Custom domain in production: `license.harmonyaio.com`.

---

## Where this code lives (read first)

This directory is a **self-contained Cloudflare Worker project** that is
currently checked in inside the `Harmony-AIO` Go monorepo at
`external/harmony-license-worker/` purely as a staging area.  It is
intended to be lifted out into its own GitHub repository,
`merch40/harmony-license-worker`, before deployment.

The worker has **no dependency on the parent Go module**:

- it never imports anything from `Harmony-AIO`,
- its `package.json`, `tsconfig.json`, `wrangler.toml`, schema, source,
  and tests are all under this one folder,
- moving the folder out of `external/` and into a fresh git repo is a
  pure `git mv` plus initial commit; nothing else changes.

The only cross-repo coupling is **byte-for-byte canonical JSON
serialization** (see §4 of the sprint brief) and a shared **Ed25519
public key** embedded in the Go server.  Both are kept in sync:

- Canonical algorithm: implemented identically in
  `src/canonical.ts` (here) and `internal/license/canonical.go` (Go).
  A fixture test in `test/canonical.test.ts` proves byte equality.
- Dev keypair: `dev.secrets.json` in this folder holds the Ed25519
  private key.  Its public counterpart is hard-coded in
  `internal/license/embed_pubkey.go` on the Go side.  Re-generating
  the keypair (via `tools/gen-license-keypair` in the Go repo) updates
  both files atomically.  **`dev.secrets.json` is gitignored.**

When the worker moves out, copy `dev.secrets.json` separately (it is
not committed in either repo) and update the README path references.

---

## Local development

Prerequisites: Node 20+, Wrangler installed via the dev dependency.

```sh
cd external/harmony-license-worker
npm install
npm test                # vitest, miniflare-backed D1 in-memory
npm run typecheck       # tsc --noEmit
npm run dev             # wrangler dev, requires .dev.vars (see .env.example)
```

To exercise the Worker against a local D1 emulator:

```sh
cp .env.example .dev.vars
# Edit .dev.vars: paste private_key_base64 from dev.secrets.json
# into HARMONY_LICENSE_SIGNING_KEY_V1, then:
npm run dev
```

---

## Deploy

1. Create the D1 database:

   ```sh
   wrangler d1 create harmony-license
   ```

   Copy the returned `database_id` into `wrangler.toml`.

2. Apply the schema and seed PA's house license:

   ```sh
   bash scripts/apply-schema.sh --remote
   # or on Windows:
   pwsh scripts/apply-schema.ps1 --remote
   ```

3. Push secrets:

   ```sh
   wrangler secret put HARMONY_LICENSE_SIGNING_KEY_V1   # base64 ed25519 private key
   wrangler secret put SESSION_SECRET                   # 32+ random bytes
   wrangler secret put ADMIN_SECRET                     # admin issuance gate
   wrangler secret put BREVO_API_KEY                    # deferred; can be empty for now
   ```

   **Production must use a separately generated keypair, not the dev
   keypair in `dev.secrets.json`.**  Generate, push the public part to
   the Go repo's `internal/license/embed_pubkey.go` under a new
   `signing_key_id` (`v2`, etc.), and only then deploy.  This is how
   key rotation works.

4. Deploy:

   ```sh
   npm run deploy
   ```

5. In the Cloudflare dashboard, bind the custom domain
   `license.harmonyaio.com` (Workers > harmony-license-worker > Triggers
   > Custom Domains > Add).

---

## Endpoints

All write endpoints rate-limit by IP and by license key (60 rpm on
`/activate` and `/validate`, 6 rpm on `/force-release`).

| Method | Path                  | Auth                | Purpose                               |
|--------|-----------------------|---------------------|---------------------------------------|
| GET    | `/health`             | none                | liveness                              |
| POST   | `/activate`           | none                | bind instance, return signed blob     |
| POST   | `/validate`           | none                | refresh blob, accept telemetry        |
| POST   | `/release`            | none                | clean release initiated by server     |
| POST   | `/force-release`      | session cookie      | release stuck binding from portal     |
| GET    | `/account/instances`  | session cookie      | list active instances by email        |
| POST   | `/auth/request`       | none                | request magic-link email              |
| GET    | `/auth/verify`        | none (token)        | consume magic-link, set session       |
| POST   | `/admin/license`      | `X-Admin-Secret`    | issue a new license (manual sales)    |

All errors use the shape:

```json
{ "error": { "code": "license_rejected", "reason": "license key not found" } }
```

`code` values match `internal/license/errors.go` on the Go side so the
dashboard can render the right UI per failure mode.

---

## Schema

`schema/001_initial.sql` is the authoritative D1 schema for licenses,
instances, activations, telemetry, release cooldowns, magic links, and
rate-limit counters.  `schema/002_seed_pa.sql` inserts PA's perpetual
Pro license, `HRM-PRO-PA00-DOGF-OOD1`, with `pack_size = 100` and no
expiry.  Both are idempotent.

---

## Magic-link auth (Brevo deferred)

The magic-link request endpoint logs the verify URL to `console.log`
instead of emailing it.  Hooking up Brevo is deferred per §17 of the
sprint brief; when ready, replace the `console.log` line in
`src/magic_link.ts::handleAuthRequest` with a Brevo API call.

Sessions are JWT-shaped (header.body.HMAC-SHA256), 24-hour TTL,
HttpOnly + Secure + SameSite=Lax.

---

## Tests

`vitest run` (alias `npm test`) executes:

- `canonical.test.ts` — byte-equality fixture against the Go canonical
  output.  This is the test that catches signature drift early.
- `activate.test.ts` — happy path, idempotent rebind, 409 mismatch,
  expired, revoked, missing-fields.
- `validate.test.ts` — telemetry insert, expiry roll, mismatch.
- `release.test.ts` — clean release, force-release auth + cooldown.
- `integration.test.ts` — end-to-end admin issuance through release,
  including `@noble/ed25519` signature verify against the dev public
  key.

---

## Maintaining canonical-byte parity with the Go side

If `internal/license/types.go` (Go) ever changes, regenerate the
fixture:

```sh
# from inside the Harmony-AIO repo, NOT from the worker dir
go run ./external/harmony-license-worker/scripts/gen-canonical-fixture
```

Paste the printed line into `test/fixtures.ts` as `EXPECTED_CANONICAL`,
update `FIXED_LICENSE` to match, and run `npm test` to confirm parity.
The Go script is included in `scripts/` for convenience but is the only
file in the worker tree that imports the Go module — it stays behind
when the worker moves to its own repo.
