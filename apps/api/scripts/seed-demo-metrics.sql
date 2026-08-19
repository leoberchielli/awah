-- Métricas sintéticas para ver o painel antes de haver tráfego real.
--
-- Instância nova mostra painel vazio, o que é correto e pouco informativo: não
-- dá para saber se um gráfico está sem dados ou quebrado. Este arquivo grava 24
-- horas de série numa curva senoidal — variação suficiente para os eixos, os
-- percentis e o funil se comportarem como se comportariam em uso.
--
-- Escreve APENAS em metrics_hourly. Não cria mensagem, sessão nem evento, e por
-- isso não interfere em nada que o gateway faça de verdade.
--
--   docker compose exec -T postgres psql -U awah -d awah -f /dev/stdin \
--     < apps/api/scripts/seed-demo-metrics.sql
--
-- Para remover, veja o DELETE comentado no fim.

INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
SELECT o.id,
       NULL::uuid,
       date_trunc('hour', now()) - (h || ' hours')::interval,
       m.metric,
       greatest(0, round((m.base * (1 + 0.45 * sin(h / 3.0)))::numeric, 0))::float8
FROM orgs o
CROSS JOIN generate_series(0, 23) AS h
CROSS JOIN (VALUES
  ('messages.outbound', 180),
  ('messages.inbound', 120),
  ('status.delivered', 172),
  ('status.read', 131),
  ('status.failed', 6),
  ('risk.allowed', 165),
  ('risk.delayed', 11),
  ('risk.throttled', 9),
  ('risk.held', 4),
  ('risk.score.avg', 28),
  ('contacts.new', 3),
  ('webhook.delivered', 290),
  ('latency.delivered.p50', 1200),
  ('latency.delivered.p95', 3400),
  ('latency.delivered.p99', 9800)
) AS m(metric, base)
ON CONFLICT (org_id, session_id, bucket, metric) DO UPDATE SET value = EXCLUDED.value;

-- Desfazer:
--
-- DELETE FROM metrics_hourly WHERE session_id IS NULL;
