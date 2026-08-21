import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { enforceDemo } from './guard'
import {
  DEMO_API_KEY,
  DEMO_ORG_ID,
  DEMO_ORG_SLUG,
  DEMO_SESSION_IDS,
  DEMO_WEBHOOK_PATH,
  resetDemo,
  seedDemo,
} from './seed'

export interface DemoInfo {
  email: string
  password: string
  /** Published on purpose: it is what makes the `curl` in the docs runnable. */
  apiKey: string
  orgSlug: string
  resetMinutes: number
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Null on an ordinary instance. Everything demo-shaped keys off this. */
    demo: DemoInfo | null
  }
}

/**
 * The public demo.
 *
 * The instance is a real one: the same queue, the same risk engine, the same
 * ACK reconciliation, the same webhooks with the same signature. Three things
 * are different, and all three are announced rather than hidden — the engine is
 * the simulator instead of a phone, the admin credentials are fixed and
 * published, and the whole organization goes back to its baseline on a timer.
 *
 * The seed writes a month of history because an empty dashboard teaches
 * nothing: every panel here answers "what does an operation look like", and
 * that question has no answer at zero rows. What the visitor does from then on
 * is not seeded at all — a message sent from the panel goes through the outbox,
 * the budget, the score, the jitter and the ACK trail exactly as it would
 * against a real number.
 */
export const demoPlugin = fp(
  async (app: FastifyInstance) => {
    if (!app.env.DEMO_MODE) {
      app.decorate('demo', null)
      return
    }

    app.decorate('demo', {
      email: app.env.DEMO_EMAIL,
      password: app.env.DEMO_PASSWORD,
      apiKey: DEMO_API_KEY,
      orgSlug: DEMO_ORG_SLUG,
      resetMinutes: app.env.DEMO_RESET_MINUTES,
    } satisfies DemoInfo)

    /*
     * `preHandler` and not `onRequest`: the refusal for a non-simulator engine
     * reads the body, and the body does not exist yet at `onRequest`. It also
     * runs after the route's own auth, so an anonymous request gets the 401 it
     * deserves instead of a lecture about the demo.
     */
    app.addHook('preHandler', async (request) => {
      enforceDemo(request)
    })

    /**
     * Somewhere for the seeded webhook to point.
     *
     * A demo whose webhook target does not exist shows a dead queue and teaches
     * the wrong lesson — that deliveries fail here. This endpoint answers 200
     * and does nothing else, which is precisely what the receiving end of a
     * webhook looks like when it is working.
     */
    app.post(
      DEMO_WEBHOOK_PATH,
      { schema: { tags: ['system'], summary: 'Demo webhook sink', hide: true } },
      async (_request, reply) => reply.code(204).send(),
    )

    const seedDeps = {
      db: app.db,
      logger: app.log,
      email: app.env.DEMO_EMAIL,
      password: app.env.DEMO_PASSWORD,
      publicUrl: app.env.PUBLIC_URL ?? null,
    }

    app.addHook('onReady', async () => {
      const result = await seedDemo(seedDeps)
      app.log.info(
        { orgId: result.orgId, messages: result.messages, email: app.env.DEMO_EMAIL },
        'demo instance ready',
      )
    })

    if (app.env.DEMO_RESET_MINUTES > 0) {
      const intervalMs = app.env.DEMO_RESET_MINUTES * 60_000
      const timer = setInterval(() => {
        void reset(app, seedDeps).catch((error) => {
          app.log.error({ err: error }, 'demo reset failed')
        })
      }, intervalMs)
      // Nothing should be held open by the demo's own clock.
      timer.unref()

      app.addHook('onClose', async () => {
        clearInterval(timer)
      })
    }
  },
  { name: 'awah-demo', dependencies: ['awah-sessions'] },
)

/**
 * Stops the demo's sessions, throws the organization away and builds it again.
 *
 * The sessions have to come down first. Deleting the rows underneath a running
 * adapter leaves the manager holding a socket for a session that no longer
 * exists, and the next engine event lands on a foreign key that is gone.
 */
async function reset(app: FastifyInstance, deps: Parameters<typeof resetDemo>[0]): Promise<void> {
  for (const sessionId of Object.values(DEMO_SESSION_IDS)) {
    await app.sessions.stop(DEMO_ORG_ID, sessionId).catch(() => {
      /* Not running here, or running on another replica. Either is fine. */
    })
  }

  const result = await resetDemo(deps)
  app.log.info({ messages: result.messages }, 'demo reset to its baseline')
}
