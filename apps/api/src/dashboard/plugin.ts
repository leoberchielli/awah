import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

declare module 'fastify' {
  interface FastifyInstance {
    /** HTML do dashboard, ou null quando ele não foi empacotado nesta imagem. */
    spaIndex: string | null
  }
}

/**
 * Prefixos que pertencem ao servidor, não ao dashboard.
 *
 * O SPA responde a qualquer caminho que ele não conheça — é assim que rota de
 * cliente funciona. Sem esta lista, um `GET /v1/sessoes` digitado errado
 * devolveria a página HTML com status 200, e quem integra passaria a tarde
 * tentando entender por que o JSON virou `<!doctype html>`.
 */
const RESERVADOS = ['/v1/', '/webhooks/', '/metrics', '/docs', '/health', '/ready']

export function ehRotaDoServidor(url: string): boolean {
  const caminho = url.split('?')[0] ?? url
  return RESERVADOS.some((prefixo) =>
    prefixo.endsWith('/') ? caminho.startsWith(prefixo) : caminho === prefixo,
  )
}

/**
 * Descobre onde estão os arquivos do dashboard.
 *
 * São três cenários reais e nenhum se deriva dos outros: a imagem Docker copia o
 * build para `public`, ao lado do bundle; o monorepo em desenvolvimento tem
 * `apps/web/dist`; e quem empacota de outro jeito aponta DASHBOARD_DIR. A ordem
 * é essa — explícito ganha de convenção.
 */
export function encontrarDashboard(dirExplicito?: string): string | null {
  const candidatos = dirExplicito
    ? [isAbsolute(dirExplicito) ? dirExplicito : resolve(process.cwd(), dirExplicito)]
    : [
        resolve(process.cwd(), 'public'),
        resolve(process.cwd(), 'apps/api/public'),
        resolve(process.cwd(), '../web/dist'),
        resolve(process.cwd(), 'apps/web/dist'),
      ]

  for (const candidato of candidatos) {
    if (existsSync(join(candidato, 'index.html'))) return candidato
  }

  return null
}

/**
 * Serve o dashboard pela mesma origem da API.
 *
 * Mesma origem não é detalhe de empacotamento: é o que permite que a credencial
 * do painel seja um cookie `httpOnly` em vez de um token no `localStorage`. Em
 * origens separadas o navegador exigiria `SameSite=None`, e aí o cookie passa a
 * viajar em requisição de terceiro — exatamente o que ele deveria impedir.
 *
 * O 404 não é tratado aqui: quem responde continua sendo o handler único do
 * `app.ts`, que consulta `spaIndex`. Dois handlers de 404 no mesmo contexto o
 * Fastify recusa, e mais importante — o formato de erro da API é contrato
 * público e precisa de um dono só.
 */
export const dashboardPlugin = fp(async (app: FastifyInstance) => {
  const raiz = encontrarDashboard(app.env.DASHBOARD_DIR)

  if (!raiz) {
    app.decorate('spaIndex', null)
    app.log.info(
      'dashboard não empacotado; a API sobe só com as rotas HTTP (`pnpm --filter @awah/web build` gera os arquivos)',
    )
    return
  }

  await app.register(fastifyStatic, {
    root: raiz,
    prefix: '/',
    /**
     * Sem rota curinga: o plugin varre a pasta no boot e registra uma rota por
     * arquivo. Assim nenhum `GET /*` fica na frente das rotas da API, e tudo que
     * não é arquivo cai limpo no handler de 404.
     */
    wildcard: false,
    index: false,
    setHeaders(resposta, caminho) {
      /**
       * Os arquivos de `assets/` têm hash do conteúdo no nome: mudou o conteúdo,
       * mudou o nome. Podem ser cacheados para sempre. O `index.html` não tem
       * hash e é justamente ele que aponta para os nomes novos — cacheá-lo
       * deixaria o navegador preso na versão anterior depois de um deploy.
       */
      if (caminho.includes(`${sep}assets${sep}`)) {
        resposta.header('cache-control', 'public, max-age=31536000, immutable')
      } else {
        resposta.header('cache-control', 'no-cache')
      }
    },
  })

  app.decorate('spaIndex', await readFile(join(raiz, 'index.html'), 'utf8'))
  app.log.info({ raiz }, 'dashboard sendo servido pela API')
})
