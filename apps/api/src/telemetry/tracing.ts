import { type Attributes, SpanStatusCode, trace } from '@opentelemetry/api'

const tracer = trace.getTracer('awah')

/**
 * Trace instrumentation using **the API only** of OpenTelemetry.
 *
 * The choice is deliberate: `@opentelemetry/api` is an interface of a few
 * kilobytes and, with no SDK registered, every call turns into a no-op of
 * negligible cost. Bundling the full SDK with auto-instrumentation would add
 * tens of megabytes of dependency to a project whose whole thesis is being
 * light — and would charge that to everyone, including those who will never
 * look at a trace.
 *
 * Anyone who wants tracing plugs the SDK in at boot, without touching this
 * code:
 *
 *   node --require ./otel.js apps/api/dist/index.js
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn()
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      })
      if (error instanceof Error) span.recordException(error)
      throw error
    } finally {
      span.end()
    }
  })
}

/** Annotates the current span without creating a new one. */
export function annotate(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes)
}
