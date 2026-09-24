/**
 * Baseline role model.
 *
 * PRD §15: the client-facing Client Admin is separate from Archava Studio and
 * must be role-scoped. Client users must never reach ARCHZXY provider secrets,
 * global pricing configuration, cross-tenant data, internal margin/COGS data,
 * unsupported action permissions, or raw system prompts.
 *
 * The roles below are the minimum viable baseline. A per-client override can
 * narrow them further but can never widen past `owner` from a lower role.
 */

/** Admin resources a role may act on. Mirrors PRD §15. */
export const ADMIN_RESOURCES = [
  'content',
  'products',
  'media',
  'knowledge',
  'leads',
  'bookings',
  'conversations',
  'handoff_queue',
  'analytics',
  'members',
  'settings',
] as const
export type AdminResource = (typeof ADMIN_RESOURCES)[number]

/** What a role may do with a resource. */
export type AdminPermission = 'read' | 'write' | 'configure'

export interface RoleDefinition {
  readonly name: RoleName
  readonly label: string
  readonly description: string
  /** Resources this role may read. */
  readonly read: readonly AdminResource[]
  /** Resources this role may write. */
  readonly write: readonly AdminResource[]
  /** Resources whose settings/permissions this role may change. */
  readonly configure: readonly AdminResource[]
}

export const ROLE_NAMES = ['archava_assistant', 'owner', 'admin', 'editor', 'viewer'] as const
export type RoleName = (typeof ROLE_NAMES)[number]

const ALL_RESOURCES: readonly AdminResource[] = ADMIN_RESOURCES

/**
 * The assistant is a machine actor. It holds no admin resource access at all —
 * it can only invoke actions the action registry and the client's capability
 * tier permit. Keeping its admin sets empty makes cross-resource admin access a
 * compile-time impossibility rather than a policy check.
 */
const ASSISTANT: RoleDefinition = {
  name: 'archava_assistant',
  label: 'Archava (assistant)',
  description:
    'Machine actor for the digital employee. Holds no admin resource access; acts only through the versioned action registry.',
  read: [],
  write: [],
  configure: [],
}

const OWNER: RoleDefinition = {
  name: 'owner',
  label: 'Owner',
  description: 'Full control of this tenant, including members and settings.',
  read: ALL_RESOURCES,
  write: ALL_RESOURCES,
  configure: ALL_RESOURCES,
}

const ADMIN: RoleDefinition = {
  name: 'admin',
  label: 'Admin',
  description: 'Day-to-day administration of the tenant. Cannot manage members or tenant settings.',
  read: ALL_RESOURCES,
  write: ALL_RESOURCES.filter((resource) => resource !== 'members' && resource !== 'settings'),
  configure: [],
}

const EDITOR: RoleDefinition = {
  name: 'editor',
  label: 'Editor',
  description: 'Content, media, and knowledge maintenance. No settings or member access.',
  read: [
    'content',
    'products',
    'media',
    'knowledge',
    'leads',
    'bookings',
    'conversations',
    'handoff_queue',
    'analytics',
  ],
  write: ['content', 'products', 'media', 'knowledge'],
  configure: [],
}

const VIEWER: RoleDefinition = {
  name: 'viewer',
  label: 'Viewer',
  description: 'Read-only, including analytics.',
  read: [
    'content',
    'products',
    'media',
    'knowledge',
    'leads',
    'bookings',
    'conversations',
    'handoff_queue',
    'analytics',
  ],
  write: [],
  configure: [],
}

export const BASELINE_ROLES: readonly RoleDefinition[] = [ASSISTANT, OWNER, ADMIN, EDITOR, VIEWER]

const ROLE_BY_NAME = new Map<RoleName, RoleDefinition>(
  BASELINE_ROLES.map((role) => [role.name, role]),
)

export class RoleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoleError'
  }
}

export function getRole(name: RoleName): RoleDefinition {
  const role = ROLE_BY_NAME.get(name)
  if (!role) {
    throw new RoleError(
      `Unknown role "${name}". Baseline roles: ${BASELINE_ROLES.map((entry) => entry.name).join(', ')}.`,
    )
  }
  return role
}

export function isRoleName(value: unknown): value is RoleName {
  return typeof value === 'string' && ROLE_BY_NAME.has(value as RoleName)
}

/** True when the role may act on the resource at the requested level. */
export function roleCan(
  role: RoleName,
  resource: AdminResource,
  permission: AdminPermission,
): boolean {
  const definition = getRole(role)
  if (permission === 'read') return definition.read.includes(resource)
  if (permission === 'write') return definition.write.includes(resource)
  return definition.configure.includes(resource)
}
