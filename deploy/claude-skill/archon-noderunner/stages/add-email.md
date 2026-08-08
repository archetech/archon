# Stage: `add-email`

Enable Herald email-challenge flow (email-based DID verification).

## Prereqs

- SMTP relay account with sender authorization for `noreply@<domain>` (or similar).
  Common choices: Postmark, AWS SES, Mailgun, SendGrid, Fastmail.
- MX / SPF / DKIM DNS records for the domain (may already be in place).

## Procedure

1. **🛑 Human checkpoint — SMTP credentials.** Ask for:
   - SMTP host + port (e.g. `smtp.postmarkapp.com:587`)
   - Username / API key
   - Password / secret
   - `From:` address the relay allows

2. **Splice** into `.env`:
   ```
   ARCHON_HERALD_SMTP_HOST={{host}}
   ARCHON_HERALD_SMTP_PORT={{port}}
   ARCHON_HERALD_SMTP_USER={{user}}
   ARCHON_HERALD_SMTP_PASS={{pass}}
   ARCHON_HERALD_SMTP_FROM={{from}}
   ARCHON_HERALD_URL=http://herald:4230
   # Explicitly empty: this stage does not enable the `tor` profile. The compose
   # default is `${ARCHON_HERALD_TOR_PROXY-tor:9050}` (single dash), so leaving
   # the key UNSET still resolves to tor:9050 and Herald would dial a container
   # that isn't running. Only an explicit empty value disables onion egress.
   ARCHON_HERALD_TOR_PROXY=
   ```
   Append `herald` to `COMPOSE_PROFILES` (it carries `herald` and `herald-client`; ensure `drawbridge` is present too, since Drawbridge is what fronts `/names/*`). Setting `ARCHON_HERALD_URL` in the same step is required — Drawbridge advertises and proxies `/names/*` based on that URL, not on the profile.

3. **DNS check** — verify SPF/DKIM records are in place. If not, print required records and wait for the operator to add them and confirm.

4. **Caddy** — add `names.<domain>` block routing to the herald-client:
   ```
   names.{{DOMAIN}} {
       handle /names/api/* {
           reverse_proxy localhost:4222
       }
       handle {
           reverse_proxy localhost:4231
       }
   }
   ```

5. **Bring up** herald + herald-client. Wait for readiness.

6. **Verify** — send a test challenge from `keymaster` to the operator's own inbox; confirm receipt and completion.

7. **Report** — where to point users to claim names, subject-line format, mailbox for support if `noreply@` bounces.

## Rollback

`remove-email` — remove SMTP creds from `.env`, tear down herald/herald-client, restore Caddyfile. DNS records left alone (operator's registrar).
