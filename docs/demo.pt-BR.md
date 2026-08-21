# A demonstração pública

*[English](demo.md)*

**[awah-demo.99ia.com.br](https://awah-demo.99ia.com.br)** — entre com
`admin@awah.demo` / `admin`. As credenciais estão impressas na tela de login:
não há o que pedir nem o que instalar.

A mesma instância sobe na sua máquina com um comando:

```bash
curl -O https://raw.githubusercontent.com/leoberchielli/awah/main/docker-compose.demo.yml
docker compose -f docker-compose.demo.yml up -d
```

Depois é só abrir `http://localhost:2900`.

## O que é real

Tudo, menos o último salto. Uma mensagem enviada pelo painel ou pela API é
gravada no outbox, responde `202` no instante em que a linha fica durável, passa
pelo orçamento e pelo warm-up do motor de risco, recebe uma nota, espera o
jitter humano, é despachada, é reconciliada pela trilha de ACKs e sai como
webhook assinado. Os painéis leem os mesmos agregados que leriam em produção,
sobre dados escritos pelo mesmo código.

A chave de API publicada também funciona, então a demo responde a `curl`:

```bash
curl https://awah-demo.99ia.com.br/v1/kpi/delivery?hours=24 \
  -H "authorization: Bearer awah_de3ade3ade3ade3a_public-demo-key-not-a-secret"
```

## O que não é

A engine. As sessões da demo rodam no **simulador**, que não é um cliente de
WhatsApp: ele aceita envios, inventa uma latência plausível, entrega a maioria,
derruba o socket de vez em quando e responde com mensagens recebidas — mas nada
chega a um telefone. É exatamente a falha que a trava de produção existe para
evitar, e por isso a demo se anuncia na tela de login, em `/v1/auth/me` e numa
faixa no topo de todas as telas. Motor simulado que não avisa é como uma
operação acaba acreditando que entregou mensagens que nunca saíram.

Pelo mesmo motivo a demo **recusa parear número real**: ela roda com segredos
publicados neste repositório, e a `ENCRYPTION_KEY` é o que protege o auth state
de uma sessão em repouso. Criar sessão em `baileys` ou `cloud_api` volta 403 com
essa explicação.

## Os três números

O seed escreve um mês de histórico, porque painel sem linha nenhuma não responde
nenhuma das perguntas para as quais ele existe.

| Sessão | Idade | Estado | O que ela mostra |
|---|---|---|---|
| Support | 47 dias | saudável, madura | Warm-up liberado, teto em 100% |
| Sales | 3 dias | saudável, aquecendo | A rampa: o que um número novo pode enviar |
| Billing | 12 dias | degradada | Entrega falhando, quedas, envios segurados |

A demo não ensinaria nada se estivesse tudo verde. Um gateway cuja razão de
existir é o dia em que um número para de funcionar precisa de um número que não
está funcionando.

A fila vem com mensagens na dead-letter e mensagens **seguradas** pelo motor de
risco, pelo mesmo motivo: "nada se perde, espera e diz por quê" é uma afirmação,
e fila sempre vazia é onde ela não pode ser conferida.

## O que reseta, e quando

A cada três horas a organização é apagada e reconstruída — sessões, chaves,
webhooks, integrações, mensagens, tudo. Quem estiver logado cai, porque a conta
é recriada junto.

É isso que deixa o resto da demo seguro: todo visitante entra como **owner** e
pode fazer o que um owner faz, inclusive apagar o que o visitante anterior
montou. Duas coisas ficam fora do alcance, e só duas:

- **A conta publicada** não pode ser removida, rebaixada nem renomeada. É a
  credencial da tela de login, e o próximo visitante precisa dela funcionando.
- **A organização** não pode ser apagada, porque ela é a demo.

Todo o resto — criar sessão, enviar, reprocessar uma dead-letter, emitir chave de
API, ligar uma integração, mudar os limites de risco — funciona, e volta ao
estado inicial no próximo reset.

`DEMO_RESET_MINUTES=0` desliga o reset na sua cópia.

## Rodando uma demo sua

Qualquer instância vira uma com duas variáveis:

```bash
DEMO_MODE=true
SIMULATOR_ENABLED=true
```

`DEMO_MODE` é a única coisa que libera o simulador em produção, e subir sem
`SIMULATOR_ENABLED` falha no boot: demo sem engine é uma tela de login sobre um
banco vazio. `DEMO_EMAIL`, `DEMO_PASSWORD` e `DEMO_RESET_MINUTES` mudam o resto.

O seed é idempotente — reiniciar o processo não reescreve o mês de histórico — e
nunca encosta em organização que não seja a da demo, então `DEMO_MODE` numa
instância que já tem dados acrescenta uma org de demo ao lado, sem substituir
nada.
