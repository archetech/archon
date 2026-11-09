# Stage: `add-email`

Enable Herald, the node's name service (`/names/*`, `/.well-known/*`), together with its email bridge, which relays dmail to and from ordinary email through SendGrid. Herald has no SMTP support: SendGrid sends the outbound mail and its Inbound Parse webhook delivers the inbound mail.

## Prereqs

- `drawbridge` enabled (`add-lightning` first, or add `drawbridge` alone), since Drawbridge is what fronts `/names/*`.
- A SendGrid account with **Domain Authentication** for the node's domain. Herald sends a named user's dmail from `<name>@<domain>` and other mail from the configured `From:` address, so verifying a single sender is not enough.
- DNS control for the domain, for the Inbound Parse MX record.

## Procedure

1. **🛑 Human checkpoint — SendGrid.** Ask the operator for:
   - a SendGrid API key with Mail Send permission;
   - confirmation that SendGrid shows the domain as authenticated (Settings → Sender Authentication). If it does not, print the DNS records SendGrid gives for it and wait for the operator to add them and verify;
   - the `From:` address for mail not sent by a named user (default `dmail@<domain>`), on the authenticated domain;
   - the parse host for inbound mail (default `parse.<domain>`).

2. **Splice** into `.env`. Generate the session and webhook secrets with `openssl rand -hex 32` and write them without printing them:
   ```
   ARCHON_HERALD_DOMAIN={{DOMAIN}}
   ARCHON_HERALD_SESSION_SECRET={{generated}}
   ARCHON_HERALD_SENDGRID_API_KEY={{api key}}
   ARCHON_HERALD_SENDGRID_FROM_EMAIL={{from}}
   ARCHON_HERALD_SENDGRID_PARSE_DOMAIN={{parse host}}
   ARCHON_HERALD_WEBHOOK_SECRET={{generated}}
   # Explicitly empty: this stage does not enable the `tor` profile. The compose
   # default is `${ARCHON_HERALD_TOR_PROXY-tor:9050}` (single dash), so leaving
   # the key UNSET still resolves to tor:9050 and Herald would dial a container
   # that isn't running. Only an explicit empty value disables onion egress.
   ARCHON_HERALD_TOR_PROXY=
   ```
   Herald refuses to start without `ARCHON_HERALD_SESSION_SECRET`. Append `herald` to `COMPOSE_PROFILES` (it carries `herald` and `herald-client`). Drawbridge offers `/names/*` because the profile is listed; do not set `ARCHON_HERALD_URL`.

3. **🛑 Human checkpoint — inbound mail.** Print, and wait for the operator to confirm:
   - an MX record for the parse host pointing at `mx.sendgrid.net`;
   - a SendGrid Inbound Parse entry for the parse host, posting to `https://names.{{DOMAIN}}/names/api/inbound-email?secret=<ARCHON_HERALD_WEBHOOK_SECRET>`. Read the secret from `.env` when printing this URL for the operator, and do not log it elsewhere.

   Check the MX record with `dig +short MX <parse host>`.

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

6. **Verify** — `curl -fsS https://names.{{DOMAIN}}/names/api/config` returns JSON with a `relayAgent` DID, which Herald reports only when SendGrid is configured. Then ask the operator to send an email to `<name>@<parse host>`, for a name claimed on this Herald, and confirm it arrives as dmail for that name.

7. **Report** — where users claim names, the relay agent DID, and the parse host for inbound mail.

## Rollback

`remove-email` — remove the SendGrid settings from `.env`, tear down herald/herald-client, restore Caddyfile. DNS records left alone (operator's registrar).
