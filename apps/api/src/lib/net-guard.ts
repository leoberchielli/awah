import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { badRequest } from './errors'

/**
 * Where the gateway is allowed to send a request someone else chose.
 *
 * Four features here take a URL from a user and make the server fetch it:
 * webhook subscriptions, the Chatwoot and Typebot base URLs, and the HTTP
 * connector — including its test button, which returns the response body on
 * screen. Without this check that button is a proxy into whatever the server
 * can reach and nothing else can: the metrics port on loopback, the router's
 * admin page, a cloud provider's metadata endpoint at 169.254.169.254, an
 * internal API that trusts anything coming from inside.
 *
 * That is not a hypothetical. On the public demo, where every visitor signs in
 * as owner, `POST /v1/integrations/http/test` returned the body of the LAN
 * router's home page and of a metrics endpoint on 127.0.0.1. The feature was
 * doing exactly what it was written to do.
 *
 * The rule is narrow on purpose: only http and https, no credentials in the
 * URL, and every address the name resolves to has to be a public one.
 */

/** Ranges that are not the public internet, in CIDR-ish form. */
function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true
  }
  const [a = 0, b = 0, c = 0] = parts

  if (a === 0) return true // "this network"
  if (a === 10) return true
  if (a === 127) return true // loopback
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  if (a === 169 && b === 254) return true // link-local, and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 0 && c === 0) return true // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true // documentation
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && c === 100) return true // documentation
  if (a === 203 && b === 0 && c === 113) return true // documentation
  if (a >= 224) return true // multicast, reserved, broadcast

  return false
}

function isPrivateV6(ip: string): boolean {
  const address = ip.toLowerCase().split('%')[0] ?? ''

  // IPv4 wearing an IPv6 hat — `::ffff:127.0.0.1` reaches loopback all the same.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  if (mapped?.[1]) return isPrivateV4(mapped[1])

  if (address === '::' || address === '::1') return true
  if (address.startsWith('fc') || address.startsWith('fd')) return true // unique local
  if (address.startsWith('fe8') || address.startsWith('fe9')) return true // link-local
  if (address.startsWith('fea') || address.startsWith('feb')) return true
  if (address.startsWith('ff')) return true // multicast
  if (address.startsWith('64:ff9b')) return true // NAT64, a way back to IPv4

  return false
}

/** True when the address belongs to the machine, the LAN or a reserved range. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return isPrivateV4(ip)
  if (family === 6) return isPrivateV6(ip)
  // Not an address at all: refuse rather than guess.
  return true
}

export interface TargetCheckOptions {
  /**
   * Lets private addresses through.
   *
   * There is a legitimate case for it — a Chatwoot on the same Docker network,
   * an n8n on the LAN — and it is why this is a setting and not a hard rule.
   * It is off by default because the damage when it is wrong is silent, and
   * whoever needs it knows they need it.
   */
  allowPrivate?: boolean
  /** Field name, so the error says which URL was refused. */
  field?: string
  /** Injected in tests. Defaults to the system resolver. */
  resolve?: (hostname: string) => Promise<string[]>
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses.map((entry) => entry.address)
}

/**
 * Refuses a URL the server should not be asked to fetch.
 *
 * Resolving the name here still leaves a gap: DNS can answer with a public
 * address now and a private one at connect time, moments later. Closing it
 * completely means pinning the connection to the address that was checked,
 * which the platform's `fetch` does not expose. What this does close is every
 * direct attempt — an IP literal, `localhost`, an internal name — which is what
 * the exposure actually looked like. The residual case is written down in
 * SECURITY.md rather than left for someone to discover.
 */
export async function assertPublicTarget(
  raw: string,
  options: TargetCheckOptions = {},
): Promise<URL> {
  const field = options.field ?? 'url'

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw badRequest(`The ${field} is not a valid URL.`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest(
      `The ${field} has to be http or https — "${url.protocol.replace(':', '')}" is not something this gateway sends to.`,
    )
  }

  /*
   * `http://user:pass@host` is refused because the credentials would be sent
   * by the server, from the server, to a destination the caller chose — and
   * would sit in the database in plain text afterwards.
   */
  if (url.username || url.password) {
    throw badRequest(`The ${field} must not carry credentials in the address.`)
  }

  if (options.allowPrivate) return url

  const hostname = url.hostname.replace(/^\[|\]$/g, '')

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw refusal(field, hostname)
    return url
  }

  let addresses: string[]
  try {
    addresses = await (options.resolve ?? defaultResolve)(hostname)
  } catch {
    throw badRequest(
      `The ${field} points at "${hostname}", which does not resolve from this server.`,
    )
  }

  if (addresses.length === 0) throw refusal(field, hostname)

  // Every answer has to be public: one private address in the set is enough.
  const offender = addresses.find((address) => isPrivateAddress(address))
  if (offender) throw refusal(field, `${hostname} (${offender})`)

  return url
}

function refusal(field: string, target: string) {
  return badRequest(
    [
      `The ${field} points at ${target}, which is inside this server's own network.`,
      'The gateway refuses it: a URL someone else chooses must not be a way to reach',
      'services that are not on the internet. If the destination really is internal —',
      'a Chatwoot on the same Docker network, for instance — start the instance with',
      'ALLOW_PRIVATE_INTEGRATION_TARGETS=true.',
    ].join(' '),
  )
}
