import { describe, expect, it } from 'vitest';
import {
  decideAccountChange,
  decideRoleGrant,
  isEscalation,
  wouldEscalate,
} from './escalation.policy.js';

const CATALOG = ['user.read', 'user.invite', 'role.assign', 'folio.read', 'payment.record'];

describe('wouldEscalate', () => {
  it('refuses a role holding anything the grantor lacks', () => {
    const missing = wouldEscalate(['user.read', 'role.assign'], ['user.read', 'payment.record']);
    expect(missing).toEqual(['payment.record']);
    expect(isEscalation(['user.read', 'role.assign'], ['user.read', 'payment.record'])).toBe(true);
  });

  it('allows a role that is a subset of the grantor', () => {
    expect(wouldEscalate(CATALOG, ['user.read', 'role.assign'])).toEqual([]);
    expect(isEscalation(CATALOG, ['user.read', 'role.assign'])).toBe(false);
  });

  it('allows an identical role', () => {
    expect(isEscalation(CATALOG, CATALOG)).toBe(false);
  });

  it('treats an empty grantor set as granting nothing', () => {
    expect(wouldEscalate([], ['user.read'])).toEqual(['user.read']);
  });

  it('is not fooled by a subset that happens to be large', () => {
    const big = ['a', 'b', 'c', 'd', 'e'];
    expect(wouldEscalate(big, big)).toEqual([]);
    expect(wouldEscalate(big, [...big, 'f'])).toEqual(['f']);
  });
});

describe('decideRoleGrant', () => {
  it('explains which permissions exceed the grantor', () => {
    const d = decideRoleGrant({
      grantorPermissions: ['user.read'],
      targetPermissions: ['user.read', 'user.deactivate'],
      targetIsSystemRole: false,
      grantingSelf: false,
    });
    expect(d.allowed).toBe(false);
    expect(d.missingPermissions).toEqual(['user.deactivate']);
    expect(d.reason).toMatch(/do not hold/);
  });

  it('allows a subset grant', () => {
    const d = decideRoleGrant({
      grantorPermissions: CATALOG,
      targetPermissions: ['user.read', 'role.assign'],
      targetIsSystemRole: false,
      grantingSelf: false,
    });
    expect(d.allowed).toBe(true);
  });

  it('stops an administrator changing their own role', () => {
    const d = decideRoleGrant({
      grantorPermissions: CATALOG,
      targetPermissions: CATALOG,
      targetIsSystemRole: true,
      grantingSelf: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/your own role/);
  });
});

describe('decideAccountChange', () => {
  it('refuses disabling the last administrator', () => {
    const d = decideAccountChange({
      activeAdminMemberships: 1,
      removesAdmin: true,
      disablesAccount: false,
      isSelf: false,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/last active administrator/);
  });

  it('allows removing an admin when another remains', () => {
    const d = decideAccountChange({
      activeAdminMemberships: 2,
      removesAdmin: true,
      disablesAccount: false,
      isSelf: false,
    });
    expect(d.allowed).toBe(true);
  });

  it('refuses an administrator disabling themselves', () => {
    const d = decideAccountChange({
      activeAdminMemberships: 3,
      removesAdmin: false,
      disablesAccount: true,
      isSelf: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/your own account/);
  });

  it('refuses self-removal of the admin role even with a spare admin', () => {
    const d = decideAccountChange({
      activeAdminMemberships: 2,
      removesAdmin: true,
      disablesAccount: false,
      isSelf: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/own administrator role/);
  });

  it('allows disabling an ordinary account', () => {
    const d = decideAccountChange({
      activeAdminMemberships: 2,
      removesAdmin: false,
      disablesAccount: true,
      isSelf: false,
    });
    expect(d.allowed).toBe(true);
  });

  it('allows demoting a non-admin', () => {
    const d = decideAccountChange({
      activeAdminMemberships: 1,
      removesAdmin: false,
      disablesAccount: false,
      isSelf: false,
    });
    expect(d.allowed).toBe(true);
  });
});
