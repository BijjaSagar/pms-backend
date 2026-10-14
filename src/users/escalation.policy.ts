/**
 * Privilege-escalation policy.
 *
 * Kept as pure functions with no database or request context so the rules can be
 * tested directly. That matters more than usual here: in the current catalog
 * only ADMIN holds `role.assign` and ADMIN already holds every permission, so
 * the escalation rule cannot be provoked through the HTTP API at all. Proving it
 * only through endpoints would mean asserting something that cannot happen.
 *
 * The rules become live the moment a lesser role is granted permission to
 * assign roles, and they are what stops a delegated "property manager" from
 * minting an organisation administrator.
 */

/**
 * Whether granting `targetPermissions` would exceed what the grantor holds.
 *
 * A grantor may hand out a role whose permissions are a subset of their own,
 * and an identical role. Anything strictly wider is escalation.
 */
export function wouldEscalate(
  grantorPermissions: string[],
  targetPermissions: string[],
): string[] {
  const held = new Set(grantorPermissions);
  return targetPermissions.filter((p) => !held.has(p));
}

export function isEscalation(
  grantorPermissions: string[],
  targetPermissions: string[],
): boolean {
  return wouldEscalate(grantorPermissions, targetPermissions).length > 0;
}

export interface EscalationDecision {
  allowed: boolean;
  reason?: string;
  missingPermissions?: string[];
}

/**
 * Decides a role grant.
 *
 * A system role is additionally protected from being modified by anyone who is
 * not an administrator, so a delegated granter can hand out a predefined role
 * but cannot rewrite the definitions themselves.
 */
export function decideRoleGrant(input: {
  grantorPermissions: string[];
  targetPermissions: string[];
  targetIsSystemRole: boolean;
  grantingSelf: boolean;
}): EscalationDecision {
  const missing = wouldEscalate(input.grantorPermissions, input.targetPermissions);

  if (missing.length > 0) {
    return {
      allowed: false,
      reason:
        `This role includes ${missing.length} permission(s) you do not hold ` +
        `(${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}).`,
      missingPermissions: missing,
    };
  }

  if (input.targetIsSystemRole && input.grantingSelf) {
    return {
      allowed: false,
      reason: 'You cannot change your own role. Ask another administrator.',
    };
  }

  return { allowed: true };
}

export interface AdminCount {
  activeAdminMemberships: number;
  /** True when the change would remove an admin from a target membership. */
  removesAdmin: boolean;
  /** True when the change would disable the user's account entirely. */
  disablesAccount: boolean;
  /** True when the actor is the user being changed. */
  isSelf: boolean;
}

/**
 * Decides a disable or demotion.
 *
 * Two ways to lock everyone out of the system are refused:
 *  - removing the last remaining active administrator membership
 *  - an administrator disabling their own account
 *
 * The last-admin rule is the one that bites in practice: with a single seeded
 * administrator, demoting them is irreversible through the UI.
 */
export function decideAccountChange(input: AdminCount): EscalationDecision {
  if (input.isSelf && input.disablesAccount) {
    return {
      allowed: false,
      reason: 'You cannot disable your own account. Ask another administrator.',
    };
  }

  if (input.removesAdmin && input.activeAdminMemberships <= 1) {
    return {
      allowed: false,
      reason:
        'This is the last active administrator. Promote someone else first, ' +
        'otherwise nobody could administer the system.',
    };
  }

  if (input.isSelf && input.removesAdmin) {
    return {
      allowed: false,
      reason: 'You cannot remove your own administrator role. Ask another administrator.',
    };
  }

  return { allowed: true };
}