# License administration audit history

The admin console records successful license creation, metadata/pack edits,
revocations, binding releases and permanent removals. It also records successful
and rejected password sign-ins, rate-limited sign-ins and authenticated sign-outs.
Events are visible in **Admin activity**, with a latest-event link near the page
heading, automatic refresh on the latest page, and pagination for older history.
Refresh pauses while event details are open or older history is being viewed.

Each event includes server time, a unique request reference, auth method,
admin-session identifier, Cloudflare's connecting IP and the client-reported user
agent. License events retain before/after values for an explicit set of metadata,
capacity, expiry, revocation and active-binding-count fields. Full license keys,
passwords, session cookies, signing secrets and raw request bodies are excluded.
A SHA-256 key fingerprint identifies a license internally; the UI shows only its
last four characters. Customer metadata and freeform notes remain sensitive and
are accessible only through the admin-authenticated endpoint.

## Integrity and limits

- Mutation, before/after snapshots, audit insertion and temporary snapshot cleanup
  run in one D1 `batch` transaction. A log write failure rolls back the mutation.
  Snapshots are read within that transaction, so concurrent requests cannot change
  the captured state between reads. See [D1 batch guarantees](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
- `admin_audit` has no cascading license foreign key. Removing a license retains
  its audit events. The application only inserts/reads events; it exposes no
  audit-update or audit-delete route.
- This is application-level history, not an immutable external security archive.
  Someone with direct database or deployment access could bypass or alter it.
  Direct SQL edits and customer activation/validation/release operations are not
  admin events (customer lifecycle events continue using `activations`).
- Rejected license API calls/validation failures are not recorded as successful
  changes. This does not replace a WAF or general request/security event log.
- The shared password and shared API secret cannot establish a person's identity.
  New browser logins receive distinct random session IDs; older valid cookies
  receive a non-reversible correlation fingerprint. Individual SSO identities
  should replace shared sign-in before granting access to additional operators.
- This release adds on-page visibility, not email/push alerts. No notification
  destination is configured. No historical events are invented or backfilled.
- Events have no automatic expiry in this version. Establish retention and an
  independently controlled export/archive as operational requirements develop.

## Release order

Apply the additive `schema/005_admin_audit.sql` migration to the **harmony-license**
database before deploying **harmony-license-worker**. Do not replay the initial
schema or the customer seed script. The migration creates two tables and one
index; it does not modify existing licenses. The staging table is empty after
each successful transaction (or rolled back on error).

Cloudflare authentication is currently required to complete the live release.
The migration has been applied only to the local preview database. Deploying the
new code without its migration deliberately prevents unaudited admin mutations.
Rolling back to an older Worker would also remove this protection; leaving the
audit tables in place preserves existing history.

## Validation

The automated suite covers complete admin mutation history, before/after values,
retention after deletion, denied anonymous/customer access, login/session
correlation, credential exclusion, throttled logins, cursor pagination, and
transaction rollback on simulated audit-store failure. Browser verification uses
only the local sample license and database.
