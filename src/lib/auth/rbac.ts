import { forbidden } from '@/lib/core/errors';
import type { UserRole } from '@/lib/db/types';

/**
 * Permissions are checked server-side on every mutation. The UI hides what a
 * role cannot do, but hiding is never the enforcement.
 */
export const PERMISSIONS = {
  'org:manage': ['OWNER', 'ADMIN'],
  'user:manage': ['OWNER', 'ADMIN'],
  'settings:write': ['OWNER', 'ADMIN'],
  'prospect:read': ['OWNER', 'ADMIN', 'SALES_REP', 'VIEWER'],
  'prospect:write': ['OWNER', 'ADMIN', 'SALES_REP'],
  'prospect:import': ['OWNER', 'ADMIN', 'SALES_REP'],
  'campaign:read': ['OWNER', 'ADMIN', 'SALES_REP', 'VIEWER'],
  'campaign:write': ['OWNER', 'ADMIN', 'SALES_REP'],
  'campaign:launch': ['OWNER', 'ADMIN'],
  'conversation:read': ['OWNER', 'ADMIN', 'SALES_REP', 'VIEWER'],
  'conversation:write': ['OWNER', 'ADMIN', 'SALES_REP'],
  'message:send': ['OWNER', 'ADMIN', 'SALES_REP'],
  'pipeline:read': ['OWNER', 'ADMIN', 'SALES_REP', 'VIEWER'],
  'pipeline:write': ['OWNER', 'ADMIN', 'SALES_REP'],
  'appointment:write': ['OWNER', 'ADMIN', 'SALES_REP'],
  'analytics:read': ['OWNER', 'ADMIN', 'SALES_REP', 'VIEWER'],
  'ai:configure': ['OWNER', 'ADMIN'],
  'suppression:write': ['OWNER', 'ADMIN', 'SALES_REP'],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: UserRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly UserRole[]).includes(role);
}

export function assertCan(role: UserRole, permission: Permission): void {
  if (!can(role, permission)) {
    throw forbidden(`Your role (${role}) cannot perform this action (${permission})`);
  }
}
