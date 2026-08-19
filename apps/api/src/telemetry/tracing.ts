import { type Attributes, SpanStatusCode, trace } from '@opentelemetry/api'

const tracer = trace.getTracer('awah')

/**
 * Instrumentação de trace usando **apenas a API** do OpenTelemetry.
 *
 * A escolha é deliberada: `@opentelemetry/api` é uma interface de poucos
 * quilobytes e, sem um SDK registrado, todas as chamadas viram no-op de custo
 * desprezível. Embutir o SDK completo com auto-instrumentação acrescentaria
 * dezenas de megabytes de dependência a um projeto cuja tese é ser leve — e
 * cobraria isso de todo mundo, inclusive de quem nunca vai olhar um trace.
 *
 * Quem quiser tracing pluga o SDK no boot, sem tocar neste código:
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

/** Anota o span corrente sem criar um novo. */
export function annotate(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes)
}
