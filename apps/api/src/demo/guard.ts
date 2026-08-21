import type { FastifyRequest } from 'fastify'
import { forbidden } from '../lib/errors'
import { DEMO_USER_ID } from './seed'

/**
 * What a visitor to the public demo is not allowed to do.
 *
 * The rule this enforces is narrow on purpose. Everything an operator does —
 * create a session, send, hold, retry a dead letter, mint a key, wire an
 * integration — has to work, or the demo is a screenshot with extra steps.
 * What cannot happen is the demo destroying its own front door, or a visitor
 * pairing a real phone number against a published encryption key.
 *
 * Three prohibitions, and each one exists for a different reason:
 *
 *   1. The published account cannot be removed, demoted, or renamed. It is the
 *      credential printed on the login screen; the next visitor needs it to
 *      work. This is what "fixed admin user" means in an instance where every
 *      visitor signs in as owner.
 *
 *   2. Only the simulator engine may back a session. A public instance runs
 *      with published secrets, and `ENCRYPTION_KEY` is what protects the
 *      WhatsApp auth state at rest. Pairing a real number here would hand that
 *      number's session to anyone who read the compose file.
 *
 *   3. The organization cannot be deleted. It cascades to everything the demo
 *      is, and the reset would only bring it back at the top of the next hour.
 *
 * Anything else is fair game, and the periodic reset is what makes that safe.
 */
export function demoRefusalFor(request: FastifyRequest): string | null {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null

  const path = (request.url.split('?')[0] ?? request.url).replace(/\/+$/, '')

  if (path === '/v1/org' && method === 'DELETE') {
    return 'This is a public demo: the demo organization cannot be deleted. Everything else is yours to change — it goes back to this state on the next reset.'
  }

  if (path.startsWith('/v1/org/members/')) {
    const userId = path.slice('/v1/org/members/'.length)
    if (userId === DEMO_USER_ID) {
      return 'This is a public demo: the published admin account cannot be changed or removed. It is the credential on the login screen, and the next visitor needs it to work.'
    }
  }

  if (path === '/v1/sessions' && method === 'POST') {
    /*
     * `engine` defaults to `baileys` in the route's schema, so an omitted field
     * is a real number too — the comparison is against `simulator` and never
     * against `undefined`.
     */
    const engine = (request.body as { engine?: unknown } | undefined)?.engine ?? 'baileys'
    if (engine !== 'simulator') {
      return `This is a public demo and it only runs the simulator engine. Pairing a real number here would store its WhatsApp credentials under an encryption key published in this repository — run your own instance for "${String(engine)}".`
    }
  }

  if (path.startsWith('/v1/sessions/') && path.endsWith('/credentials')) {
    return 'This is a public demo and it only runs the simulator engine, which has no credentials to store.'
  }

  return null
}

/** Throws the 403 that `demoRefusalFor` describes, when there is one. */
export function enforceDemo(request: FastifyRequest): void {
  const refusal = demoRefusalFor(request)
  if (refusal) throw forbidden(refusal)
}
