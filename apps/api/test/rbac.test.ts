import { describe, expect, it } from 'vitest'
import { apiKeyCan, apiKeyDenied, can, isRole, ROLES, roleAtLeast } from '../src/auth/rbac'

describe('role hierarchy', () => {
  it('covers every role below', () => {
    expect(roleAtLeast('owner', 'viewer')).toBe(true)
    expect(roleAtLeast('admin', 'operator')).toBe(true)
    expect(roleAtLeast('operator', 'viewer')).toBe(true)
  })

  it('does not cover roles above', () => {
    expect(roleAtLeast('viewer', 'operator')).toBe(false)
    expect(roleAtLeast('operator', 'admin')).toBe(false)
    expect(roleAtLeast('admin', 'owner')).toBe(false)
  })

  it('covers itself', () => {
    for (const role of ROLES) {
      expect(roleAtLeast(role, role)).toBe(true)
    }
  })
})

describe('user permissions', () => {
  it('lets a viewer read but not write', () => {
    expect(can('viewer', 'session:read')).toBe(true)
    expect(can('viewer', 'metrics:read')).toBe(true)
    expect(can('viewer', 'message:send')).toBe(false)
    expect(can('viewer', 'session:write')).toBe(false)
  })

  it('lets an operator send messages without administering', () => {
    expect(can('operator', 'message:send')).toBe(true)
    expect(can('operator', 'session:operate')).toBe(true)
    expect(can('operator', 'apikey:write')).toBe(false)
    expect(can('operator', 'member:write')).toBe(false)
  })

  it('reserves deleting the org and promoting to owner for the owner', () => {
    expect(can('admin', 'org:delete')).toBe(false)
    expect(can('admin', 'member:set_owner')).toBe(false)
    expect(can('owner', 'org:delete')).toBe(true)
    expect(can('owner', 'member:set_owner')).toBe(true)
  })
})

describe('API key permissions', () => {
  /**
   * This is the test that blocks privilege escalation through a leaked key: a
   * key never administers identity, not even an owner key.
   */
  it('never administers identity, even with the owner role', () => {
    expect(apiKeyCan('owner', 'apikey:write')).toBe(false)
    expect(apiKeyCan('owner', 'apikey:read')).toBe(false)
    expect(apiKeyCan('owner', 'member:write')).toBe(false)
    expect(apiKeyCan('owner', 'member:set_owner')).toBe(false)
    expect(apiKeyCan('owner', 'org:delete')).toBe(false)
    expect(apiKeyCan('owner', 'org:update')).toBe(false)
  })

  it('keeps what is normal gateway operation', () => {
    expect(apiKeyCan('operator', 'message:send')).toBe(true)
    expect(apiKeyCan('operator', 'session:operate')).toBe(true)
    expect(apiKeyCan('viewer', 'metrics:read')).toBe(true)
    expect(apiKeyCan('admin', 'session:write')).toBe(true)
  })

  it('still respects the hierarchy within what is allowed', () => {
    expect(apiKeyCan('viewer', 'message:send')).toBe(false)
    expect(apiKeyCan('operator', 'session:write')).toBe(false)
  })

  /**
   * The two refusals are not the same refusal, and the API used to say the
   * first for both: an operator key that only needed to be an admin key was
   * told that no key ever does this, and to go and sign in.
   */
  it('separates "no key ever" from "not this key"', () => {
    expect(apiKeyDenied('apikey:write')).toBe(true)
    expect(apiKeyDenied('member:write')).toBe(true)
    expect(apiKeyDenied('session:write')).toBe(false)
    expect(apiKeyDenied('message:send')).toBe(false)
  })
})

describe('isRole', () => {
  it('accepts only known roles', () => {
    expect(isRole('owner')).toBe(true)
    expect(isRole('superuser')).toBe(false)
    expect(isRole('')).toBe(false)
  })
})
