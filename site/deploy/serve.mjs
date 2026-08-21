/*
 * Servidor estático da página, para quando ela é servida direto do host em vez
 * do nginx da VM site01.
 *
 * Existe porque o host não tem nginx e a página precisa dos mesmos cabeçalhos
 * que o `deploy/nginx.conf` descreve — cache, CSP, nosniff. Um
 * `python3 -m http.server` sobe em um comando e não entrega nada disso.
 *
 * Sem dependência nenhuma, pelo mesmo motivo que o resto do diretório: o que
 * precisa de `npm install` para receber uma correção não recebe a correção.
 *
 *   AWAH_SITE_ROOT=/caminho/para/site AWAH_SITE_PORT=8092 node serve.mjs
 *
 * Escuta só na loopback: quem expõe isto para fora é o túnel do Cloudflare.
 */
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'

const ROOT = resolve(process.env.AWAH_SITE_ROOT || '.')
const PORT = Number(process.env.AWAH_SITE_PORT || 8092)
const HOST = '127.0.0.1'
const CANONICAL_HOST = process.env.AWAH_SITE_HOST || ''

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

/* Comprimir vale para texto; GIF e PNG já estão comprimidos. */
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.xml', '.txt'])

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  /*
   * `unsafe-inline` em script é o bloco que aplica tema e idioma antes da
   * primeira pintura; sem ele a página pisca no tema errado. connect-src é a
   * API do GitHub, que devolve a contagem de estrelas.
   */
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; " +
    "connect-src https://api.github.com; base-uri 'none'; form-action 'none'; " +
    "frame-ancestors 'none'",
}

/*
 * O HTML nunca fica em cache: é ele que aponta para o resto. Os arquivos de
 * /assets/ são reescritos por release mas mantêm o nome, então uma semana com
 * revalidação é o meio-termo entre rápido para quem volta e no máximo uma
 * semana de atraso para quem já tinha visto.
 */
function cacheFor(pathname) {
  if (pathname.startsWith('/assets/')) {
    return 'public, max-age=604800, stale-while-revalidate=86400'
  }
  if (pathname === '/robots.txt' || pathname === '/sitemap.xml') {
    return 'public, max-age=3600'
  }
  return 'public, max-age=0, must-revalidate'
}

/* Corpo comprimido guardado por caminho e mtime: reler e regzipar a cada
 * requisição é trabalho repetido para um arquivo que só muda no deploy. */
const gzCache = new Map()

function gzipped(file, key) {
  const hit = gzCache.get(file)
  if (hit && hit.key === key) return hit.body
  const body = gzipSync(readFileSync(file), { level: 9 })
  gzCache.set(file, { key, body })
  return body
}

function resolveInRoot(pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  const full = join(ROOT, clean)
  /* Sair da raiz por `..` é 404, não um passeio pelo disco. */
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null
  return full
}

createServer((req, res) => {
  const send = (status, headers, body) => {
    res.writeHead(status, { ...SECURITY, ...headers })
    if (req.method === 'HEAD' || body == null) return res.end()
    if (typeof body.pipe === 'function') return body.pipe(res)
    res.end(body)
  }

  /*
   * O TLS termina no Cloudflare, então quem chega por http chega aqui igual a
   * quem chega por https — só o X-Forwarded-Proto distingue. Sem este desvio, a
   * mesma página responde 200 nos dois esquemas: conteúdo duplicado para o
   * buscador, e uma versão sem cifra para quem digitou o endereço na mão.
   */
  const proto = req.headers['x-forwarded-proto']
  if (proto && proto !== 'https') {
    const host = CANONICAL_HOST || req.headers.host
    return send(
      301,
      { Location: `https://${host}${req.url}`, 'Content-Type': 'text/plain; charset=utf-8' },
      'Redirecionando para https',
    )
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(
      405,
      { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' },
      'Method Not Allowed',
    )
  }

  const url = new URL(req.url, `http://${HOST}`)
  let pathname = url.pathname

  /* Arquivos ocultos e restos de editor não viram URL. */
  if (/\/\./.test(pathname) || /\.(bak|tmp|orig|swp)$/.test(pathname)) {
    return send(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found')
  }

  if (pathname.endsWith('/')) pathname += 'index.html'

  let file = resolveInRoot(pathname)
  let stat = null
  try {
    stat = file && statSync(file)
    if (stat?.isDirectory()) {
      file = join(file, 'index.html')
      stat = statSync(file)
    }
  } catch {
    stat = null
  }

  /* Uma página só: caminho desconhecido devolve ela, não um 404 sem
   * identidade. A canônica no HTML resolve a duplicação para o buscador. */
  if (!stat) {
    pathname = '/index.html'
    file = join(ROOT, 'index.html')
    try {
      stat = statSync(file)
    } catch {
      return send(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found')
    }
  }

  const ext = extname(file)
  const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': cacheFor(pathname),
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    Vary: 'Accept-Encoding',
  }

  if (req.headers['if-none-match'] === etag) return send(304, headers)

  const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '')
  if (wantsGzip && COMPRESSIBLE.has(ext) && stat.size > 512) {
    const body = gzipped(file, etag)
    return send(
      200,
      { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': body.length },
      body,
    )
  }

  send(200, { ...headers, 'Content-Length': stat.size }, createReadStream(file))
}).listen(PORT, HOST, () => {
  console.log(`awah-site: ${ROOT} em http://${HOST}:${PORT}`)
})
