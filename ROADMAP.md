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
- [x] `wrangler deploy` the signup health probe (`GET /api/signup/health` + weekly
      cron; the cron doubles as Brevo key keep-alive). *(deployed 2026-08-14)*
- [x] External monitor: Azure App Insights standard availability test
      `signup-health-harmonyaio` (HAR-RG, PA-US-MSP-Playground) probes the health
      endpoint every 15 min from 3 US locations; alert
      `alert-harmonyaio-signup-health` emails beau.mundt@outlook.com +
      managed1staffalerts@profad.com when 2+ locations fail. The test also
      SSL-checks the cert (7-day expiry warning). *(deployed 2026-08-14 —
      note: a Claude cloud routine was tried first and retired; its sandbox
      egress proxy cannot reach harmonyaio.com)*
- [x] Welcome email — **built as a Brevo automation, not a transactional send**
      *(done 2026-08-14)*. The automation `Welcome message` triggers on a
      contact being added to list #6 (`Harmony AIO Early Access`) and sends
      subject "You're on the list." from `Harmony AIO <hello@harmonyaio.com>`.
      Copy lives in the Brevo template, so changing it needs no deploy.
      - The originally planned transactional route
        (`BREVO_WELCOME_TEMPLATE_ID` + `sendWelcomeEmail()` in the worker) was
        **removed**, not deferred. Running both would email every new signup
        twice. Do not reinstate the secret; see the note in `wrangler.jsonc`.
      - Sender is `hello@`, not `noreply@`, because the email invites a reply.
        `hello@harmonyaio.com` is a Cloudflare Email Routing rule forwarding to
        beau.mundt@outlook.com — no mailbox hosting. Brevo's reply-to override
        (which pointed at `noreply@merch40.xyz`) was cleared.
      - harmonyaio.com was already authenticated in Brevo (DKIM + DMARC).
        Email Routing added its own MX, SPF and DKIM records; there was no
        prior MX or SPF on the zone, so nothing collided.
- [ ] Activate the automation and verify end to end with a real signup from the
      live site (a plus-addressed test address). The trigger does not fire while
      the automation is Inactive, and Brevo does not backfill existing contacts.
      *(Beau)*

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
