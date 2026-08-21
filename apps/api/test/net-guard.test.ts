import { describe, expect, it } from 'vitest'
import { assertPublicTarget, isPrivateAddress } from '../src/lib/net-guard'

/** A resolver that answers whatever the test says, so no DNS is involved. */
const resolving = (...addresses: string[]) => ({
  resolve: async () => addresses,
})

describe('addresses that are not the public internet', () => {
  it('recognises the ranges that matter', () => {
    for (const ip of [
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.10.1',
      '169.254.169.254', // cloud metadata, the classic destination
      '100.64.0.1', // carrier-grade NAT, and Tailscale
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1', // loopback wearing an IPv6 hat
      '64:ff9b::7f00:1', // NAT64, another way back to IPv4
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })

  it('leaves the public internet alone', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '104.21.59.249', '172.15.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })

  it('refuses what is not an address at all', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true)
    expect(isPrivateAddress('')).toBe(true)
  })
})

describe('URLs the gateway agrees to fetch', () => {
  it('accepts a public destination', async () => {
    const url = await assertPublicTarget('https://example.com/hook', resolving('93.184.216.34'))
    expect(url.hostname).toBe('example.com')
  })

  it('accepts an IP literal that is public', async () => {
    await expect(assertPublicTarget('https://1.1.1.1/hook')).resolves.toBeInstanceOf(URL)
  })

  /**
   * The one that mattered. On the public demo this endpoint returned the body
   * of the LAN router's home page and of a metrics port on loopback.
   */
  it('refuses loopback and the LAN', async () => {
    await expect(assertPublicTarget('http://127.0.0.1:20247/metrics')).rejects.toThrow(
      'inside this server',
    )
    await expect(assertPublicTarget('http://192.168.10.1/')).rejects.toThrow('inside this server')
    await expect(assertPublicTarget('http://[::1]:2900/')).rejects.toThrow('inside this server')
  })

  it('refuses a name that resolves inward', async () => {
    await expect(
      assertPublicTarget('https://internal.example.com/', resolving('10.0.0.5')),
    ).rejects.toThrow('inside this server')
  })

  /**
   * A name with one public answer and one private one is the shape a rebinding
   * attempt takes when it hedges. One private address in the set is enough.
   */
  it('refuses when any answer is private', async () => {
    await expect(
      assertPublicTarget('https://mixed.example.com/', resolving('93.184.216.34', '127.0.0.1')),
    ).rejects.toThrow('inside this server')
  })

  it('refuses a scheme that is not http', async () => {
    await expect(assertPublicTarget('file:///etc/passwd')).rejects.toThrow('http or https')
    await expect(assertPublicTarget('gopher://example.com/')).rejects.toThrow('http or https')
  })

  it('refuses credentials embedded in the address', async () => {
    await expect(
      assertPublicTarget('https://user:secret@example.com/', resolving('93.184.216.34')),
    ).rejects.toThrow('credentials')
  })

  it('refuses a name that does not resolve', async () => {
    await expect(
      assertPublicTarget('https://nowhere.invalid/', {
        resolve: () => Promise.reject(new Error('ENOTFOUND')),
      }),
    ).rejects.toThrow('does not resolve')
  })

  it('lets an instance opt back in on purpose', async () => {
    await expect(
      assertPublicTarget('http://chatwoot:3000/', { allowPrivate: true }),
    ).resolves.toBeInstanceOf(URL)
  })
})
