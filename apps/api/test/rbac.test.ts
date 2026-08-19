import { describe, expect, it } from 'vitest'
import { apiKeyCan, can, isRole, ROLES, roleAtLeast } from '../src/auth/rbac'

describe('hierarquia de papéis', () => {
  it('cobre todos os papéis abaixo', () => {
    expect(roleAtLeast('owner', 'viewer')).toBe(true)
    expect(roleAtLeast('admin', 'operator')).toBe(true)
    expect(roleAtLeast('operator', 'viewer')).toBe(true)
  })

  it('não cobre papéis acima', () => {
    expect(roleAtLeast('viewer', 'operator')).toBe(false)
    expect(roleAtLeast('operator', 'admin')).toBe(false)
    expect(roleAtLeast('admin', 'owner')).toBe(false)
  })

  it('cobre a si mesmo', () => {
    for (const role of ROLES) {
      expect(roleAtLeast(role, role)).toBe(true)
    }
  })
})

describe('permissões de usuário', () => {
  it('deixa viewer ler mas não escrever', () => {
    expect(can('viewer', 'session:read')).toBe(true)
    expect(can('viewer', 'metrics:read')).toBe(true)
    expect(can('viewer', 'message:send')).toBe(false)
    expect(can('viewer', 'session:write')).toBe(false)
  })

  it('deixa operator enviar mensagem sem administrar', () => {
    expect(can('operator', 'message:send')).toBe(true)
    expect(can('operator', 'session:operate')).toBe(true)
    expect(can('operator', 'apikey:write')).toBe(false)
    expect(can('operator', 'member:write')).toBe(false)
  })

  it('reserva a exclusão da org e a promoção a owner para o owner', () => {
    expect(can('admin', 'org:delete')).toBe(false)
    expect(can('admin', 'member:set_owner')).toBe(false)
    expect(can('owner', 'org:delete')).toBe(true)
    expect(can('owner', 'member:set_owner')).toBe(true)
  })
})

describe('permissões de chave de API', () => {
  /**
   * Este é o teste que impede a escalada de privilégio por chave vazada: uma
   * chave nunca administra identidade, nem sendo de owner.
   */
  it('nunca administra identidade, mesmo com papel de owner', () => {
    expect(apiKeyCan('owner', 'apikey:write')).toBe(false)
    expect(apiKeyCan('owner', 'apikey:read')).toBe(false)
    expect(apiKeyCan('owner', 'member:write')).toBe(false)
    expect(apiKeyCan('owner', 'member:set_owner')).toBe(false)
    expect(apiKeyCan('owner', 'org:delete')).toBe(false)
    expect(apiKeyCan('owner', 'org:update')).toBe(false)
  })

  it('mantém o que é operação normal do gateway', () => {
    expect(apiKeyCan('operator', 'message:send')).toBe(true)
    expect(apiKeyCan('operator', 'session:operate')).toBe(true)
    expect(apiKeyCan('viewer', 'metrics:read')).toBe(true)
    expect(apiKeyCan('admin', 'session:write')).toBe(true)
  })

  it('continua respeitando a hierarquia no que é permitido', () => {
    expect(apiKeyCan('viewer', 'message:send')).toBe(false)
    expect(apiKeyCan('operator', 'session:write')).toBe(false)
  })
})

describe('isRole', () => {
  it('aceita apenas papéis conhecidos', () => {
    expect(isRole('owner')).toBe(true)
    expect(isRole('superuser')).toBe(false)
    expect(isRole('')).toBe(false)
  })
})
