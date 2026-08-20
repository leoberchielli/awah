# Security policy

*[Português](SECURITY.pt-BR.md)*

## Reporting a vulnerability

**Do not open a public issue.** Use
[GitHub's private vulnerability reporting](https://github.com/leoberchielli/awah/security/advisories/new)
— it notifies the maintainer directly and keeps the conversation closed until
there is a fix.

Include whatever you have: version, steps to reproduce, the impact you see. A
proof of concept helps a lot, but a report without one is welcome too.

Response within 72 hours. The project is maintained by one person part-time — if
the fix is going to take a while, you will hear why.

Credit in the changelog and in the advisory, unless you would rather stay
anonymous.

## Supported versions

The project has not had a stable release yet. Until v1.0, only `main` gets
security fixes.

## The threat model

What AWAH assumes and what it does not protect — reading this keeps you from
reporting a deliberate decision as a flaw.

### What is protected

- **Session credentials at rest.** The Baileys auth state and the Cloud API
  token live encrypted with AES-256-GCM in Postgres. Read access to the database
  reveals neither one.
- **API key secrets.** Stored only as SHA-256. The database does not let anyone
  reconstruct the key.
- **Passwords.** argon2id with the parameters OWASP recommends.
- **Isolation between organizations.** All data access goes through
  tenant-scoped repositories, which refuse to query without an `orgId`.
- **Key scope.** A key with `sessionScope` answers **404**, not 403, for sessions
  outside its scope — a 403 would confirm the session exists.
- **Separation between credentials.** An API key never administers identity: it
  does not create other keys, does not promote members, does not change the
  organization. When a key leaks, the damage should be "someone sent messages in
  my name", not account takeover.
- **Webhook replay.** The signature covers `timestamp.body`. A captured delivery
  cannot be resent after the window, and changing the timestamp invalidates the
  signature.
- **Forged Meta events.** The callback is the only public endpoint, and that is
  exactly why `appSecret` is required. The check is an HMAC over the raw bytes.

### What is not protected

- **Write access to Postgres or Redis.** Whoever writes to the database controls
  the gateway. There is no defense against that, and there should not be — treat
  both as part of the trust surface.
- **The encryption key.** `ENCRYPTION_KEY` sits in an environment variable.
  Whoever reads the process environment decrypts the sessions. If that is not
  acceptable in your scenario, the place to solve it is a KMS, and the project
  does not integrate one yet.
- **Getting blocked by WhatsApp.** The risk engine lowers the probability. It
  guarantees nothing, and no configuration of it makes the unofficial engine safe
  under the platform's terms of use.
- **Message content in transit to your webhook.** It is HTTPS up to your
  endpoint; past that it is on you.
- **Distributed denial of service.** There is rate limiting per key and per IP,
  and a body size cap. That holds off ordinary abuse, not a coordinated attack —
  for that, put a proxy or CDN in front.

## Before exposing an instance

The minimum list. The process enforces the first three on its own; the rest it
does not.

1. **Generate your own secrets.** Under `NODE_ENV=production` the API refuses to
   start with this repository's development values — they are in
   `docker-compose.yml` and `.env.example`, and whoever reads them forges a
   session cookie and decrypts the sessions.

   ```bash
   openssl rand -base64 32   # ENCRYPTION_KEY
   openssl rand -base64 48   # COOKIE_SECRET
   ```

2. **Set `METRICS_TOKEN`.** Without it, `/metrics` hands message volume, session
   count and operational health to anyone who can reach the port. The API warns
   at boot when it is missing.

3. **Configure `TRUST_PROXY` for your topology.** The default is `false`.
   Turning it on with no proxy in front lets any client pick its own IP via
   `X-Forwarded-For` and slip past the rate limit. Behind a proxy, prefer the
   CIDR list over unrestricted trust.

4. **Use `NODE_ENV=production`.** That is what turns on the `secure` flag of the
   session cookie. Outside production the cookie travels without it.

5. **Terminate TLS before the API.** AWAH speaks HTTP; HTTPS is spoken by the
   proxy or the load balancer in front of it.

6. **Do not expose Postgres or Redis.** In this repository's
   `docker-compose.yml` both ports are published to make development easier. In
   production, take that out.

7. **Close registration.** `POST /v1/auth/register` already closes itself once an
   organization exists, but check that it does exist before opening the door.

## Disclosure

Security fixes ship in their own release, with a published advisory. If the flaw
allows remote exploitation without authentication, the advisory comes before the
technical details.
