export const ROLES = ['viewer', 'operator', 'admin', 'owner'] as const
export type Role = (typeof ROLES)[number]

/** Hierarchy: a role covers everything the roles below it cover. */
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
 * Named permission → the lowest role that satisfies it.
 *
 * We prefer names to role checks scattered across the routes: when an
 * operation's requirement changes, it changes here and nowhere else.
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
 * Operations an API key never runs, whatever its role.
 *
 * A leaked key is a secret in transit through third-party systems. If it could
 * create other keys or promote members, the damage would stop being "someone
 * sent messages in my name" and become an account takeover. Identity
 * administration requires a user session.
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
  if (apiKeyDenied(permission)) return false
  return can(role, permission)
}

/**
 * Whether the operation is closed to API keys whatever their role.
 *
 * Separate from `apiKeyCan` because the two refusals need different answers.
 * "No key does this, use a user session" and "this key's role is too low" send
 * the reader in opposite directions, and the API used to give the first message
 * for both — so the operator who only needed an admin key was told to go and
 * sign in instead.
 */
export function apiKeyDenied(permission: Permission): boolean {
  return API_KEY_DENIED.has(permission)
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value)
}
