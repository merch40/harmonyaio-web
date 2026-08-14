# harmonyaio.com → Professional Advantage transition roadmap

Status: agreed 2026-08-14. This covers the **web properties** (harmonyaio.com site,
workers, email, DNS) as Harmony AIO is brought into Professional Advantage (PA).
The product roadmap lives in the Harmony-AIO repo (`docs/ROADMAP.md`); this file is
only about moving the website's infrastructure and email out of personal accounts
and into PA's environment.

## Where things stand

| Piece | Today | Target |
|---|---|---|
| Newsletter signup (`/api/signup`) | Brevo (personal account) | D365 CRM (PA tenant) |
| Transactional email (license magic links, receipts — not built yet) | deferred, was planned on Brevo | Azure Communication Services Email (PA tenant) |
| DNS zone + Workers (harmonyaio.com) | Beau's personal Cloudflare | PA-owned Cloudflare account (hosting itself stays on Cloudflare unless PA policy requires otherwise) |
| Update channel (updates.harmonyaio.com) | Azure Front Door + `paazharupdatescf9d` storage + Key Vault signing | already PA Azure — no move needed |

## Phases

### Phase 0 — restore signup on Brevo (now)

Brevo stays the working system until the D365 migration is ready; a dead signup
page shouldn't wait on a CRM project.

- [ ] Re-add `BREVO_API_KEY` / `BREVO_LIST_ID` as **wrangler secrets** (see
      `wrangler.jsonc` header comment for the commands and the July 2026
      vars-wipe incident that killed them). *(Beau)*
- [x] Verify: `POST /api/signup` returns `{"success":true}`. *(done 2026-08-14)*
- [ ] `wrangler deploy` the signup health probe (`GET /api/signup/health` + weekly
      cron). The cron doubles as Brevo key keep-alive; a weekly scheduled check
      against the endpoint notifies on failure so the form can't die silently again.
- [ ] Optional welcome email: authenticate harmonyaio.com as a Brevo sending
      domain (DKIM/SPF records in Cloudflare DNS), create a transactional
      template with sender noreply@harmonyaio.com, then
      `npx wrangler secret put BREVO_WELCOME_TEMPLATE_ID`.

### Phase 1 — account ownership (near term, independent of any code)

The liability is prospect emails and production DNS living in personally-held
accounts, not the technology choices.

- [ ] Move (or transfer membership of) the harmonyaio.com Cloudflare zone and the
      `harmonyaio-web` / license workers to a PA-controlled Cloudflare account;
      domain registration too if it's personal.
- [ ] Put the Brevo account under PA ownership/billing, or at minimum export the
      contact list to PA-held storage so no data is stranded if the account lapses.
- [ ] Record deploy credentials (Cloudflare API token for wrangler) in PA's secret
      management rather than a personal login.

### Phase 2 — marketing email to D365 CRM

PA runs marketing on D365 CRM; the newsletter list belongs there.

- [ ] One-time migration: export Brevo contacts (CSV) → import as leads/contacts
      with an appropriate consent/topic tag in D365.
- [ ] Repoint `/api/signup`: Worker writes to Dataverse instead of Brevo (Entra ID
      app registration, client-credentials flow, secret in wrangler; or a D365
      Customer Insights form endpoint if marketing prefers to own the form).
- [ ] Unsubscribe/consent handling moves to D365's compliance features.
- [ ] Decommission Brevo (revoke API key, close or archive the account).

### Phase 3 — transactional email on ACS (when the license/magic-link work resumes)

- [ ] Build license-worker magic-link + license email sending on **Azure
      Communication Services Email** in the PA tenant (custom domain + SPF/DKIM
      for a harmonyaio.com sending subdomain). Brevo is no longer the plan of
      record for this — see `license-worker/README.md`.
- [ ] Secrets live in PA Key Vault / wrangler secrets, consistent with the update
      pipeline's existing Key Vault signing setup.

## Order of operations

Phase 0 is immediate. Phase 1 is the highest-value move and needs no code. Phases
2 and 3 are independent of each other; Phase 2 waits on D365 marketing setup
(coordinate with whoever owns D365 CRM at PA), Phase 3 rides with the deferred
license-worker email work.
