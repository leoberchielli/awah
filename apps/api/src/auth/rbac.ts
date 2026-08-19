export const ROLES = ['viewer', 'operator', 'admin', 'owner'] as const
export type Role = (typeof ROLES)[number]

/** Hierarquia: um papel cobre tudo que os papéis abaixo dele cobrem. */
const RANK: Record<Role, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
  owner: 3,
}

export function roleAtLeast(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required]
}

/**
 * Permissão nomeada → papel mínimo que a satisfaz.
 *
 * Preferimos nomes a checagens de papel espalhadas pelas rotas: quando o
 * requisito de uma operação muda, muda aqui e em nenhum outro lugar.
 */
export const PERMISSIONS = {
  'org:read': 'viewer',
  'org:update': 'admin',
  'org:delete': 'owner',

  'member:read': 'viewer',
  'member:write': 'admin',
  'member:set_owner': 'owner',

  'apikey:read': 'admin',
  'apikey:write': 'admin',

  'session:read': 'viewer',
  'session:operate': 'operator',
  'session:write': 'admin',

  'message:read': 'viewer',
  'message:send': 'operator',

  'webhook:read': 'viewer',
  'webhook:write': 'admin',

  'metrics:read': 'viewer',
} as const satisfies Record<string, Role>

export type Permission = keyof typeof PERMISSIONS

export function can(role: Role, permission: Permission): boolean {
  return roleAtLeast(role, PERMISSIONS[permission])
}

/**
 * Operações que uma chave de API nunca executa, qualquer que seja o papel dela.
 *
 * Uma chave vazada é um segredo em trânsito por sistemas de terceiros. Se ela
 * pudesse criar outras chaves ou promover membros, o estrago deixaria de ser
 * "mandaram mensagem no meu nome" e viraria tomada de conta. Administração de
 * identidade exige sessão de usuário.
 */
const API_KEY_DENIED = new Set<Permission>([
  'org:delete',
  'org:update',
  'member:write',
  'member:set_owner',
  'apikey:read',
  'apikey:write',
])

export function apiKeyCan(role: Role, permission: Permission): boolean {
  if (API_KEY_DENIED.has(permission)) return false
  return can(role, permission)
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value)
}
