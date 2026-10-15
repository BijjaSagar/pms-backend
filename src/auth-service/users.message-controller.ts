import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { USER_MESSAGES, type ActorContext } from '../contracts/auth.messages.js';
import { toRpcException } from '../common/rpc-to-http.js';
import { UsersService } from './users.service.js';
import { RolesService } from './roles.service.js';

interface InviteInput {
  email: string;
  fullName: string;
  propertyId?: string;
  roleKey: string;
  expiresAt?: string | null;
}

/**
 * Staff, role and permission commands.
 *
 * The actor is sent by the gateway rather than read from an Express request:
 * this process has no HTTP layer, so the authenticated principal arrives as
 * data. The escalation and audit rules read it exactly as they read `req.user`
 * before.
 */
@Controller()
export class UsersMessageController {
  constructor(
    private readonly users: UsersService,
    private readonly roles: RolesService,
  ) {}

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toRpcException(error);
    }
  }

  // -------------------------------------------------------------------- staff

  @MessagePattern(USER_MESSAGES.LIST)
  list(@Payload() data: { actor: ActorContext }) {
    return this.run(() => this.users.list(data.actor));
  }

  @MessagePattern(USER_MESSAGES.GET)
  get(@Payload() data: { actor: ActorContext; userId: string }) {
    return this.run(() => this.users.get(data.actor, data.userId));
  }

  @MessagePattern(USER_MESSAGES.INVITE)
  invite(@Payload() data: { actor: ActorContext; input: InviteInput }) {
    return this.run(() => this.users.invite(data.actor, data.input));
  }

  @MessagePattern(USER_MESSAGES.REISSUE_INVITE)
  reissueInvite(
    @Payload() data: { actor: ActorContext; userId: string; expiresAt?: string | null },
  ) {
    return this.run(() => this.users.reissueInvite(data.actor, data.userId, data.expiresAt ?? null));
  }

  @MessagePattern(USER_MESSAGES.CANCEL_INVITE)
  cancelInvite(@Payload() data: { actor: ActorContext; userId: string }) {
    return this.run(() => this.users.cancelInvite(data.actor, data.userId));
  }

  @MessagePattern(USER_MESSAGES.ACCEPT_INVITE)
  acceptInvite(@Payload() data: { token: string; password: string }) {
    return this.run(() => this.users.acceptInvite(data.token, data.password));
  }

  @MessagePattern(USER_MESSAGES.UPDATE)
  update(@Payload() data: { actor: ActorContext; userId: string; patch: { fullName?: string } }) {
    return this.run(() => this.users.updateProfile(data.actor, data.userId, data.patch));
  }

  @MessagePattern(USER_MESSAGES.SET_ROLE)
  setRole(
    @Payload() data: { actor: ActorContext; userId: string; propertyId: string; roleKey: string },
  ) {
    return this.run(() => this.users.setRole(data.actor, data.userId, data.propertyId, data.roleKey));
  }

  @MessagePattern(USER_MESSAGES.SET_STATUS)
  setStatus(
    @Payload() data: { actor: ActorContext; userId: string; status: 'ACTIVE' | 'DISABLED' },
  ) {
    return this.run(() => this.users.setStatus(data.actor, data.userId, data.status));
  }

  // -------------------------------------------------------------------- roles

  @MessagePattern(USER_MESSAGES.ROLES_LIST)
  rolesList(@Payload() data: { actor: ActorContext }) {
    return this.run(() => this.roles.list(data.actor));
  }

  @MessagePattern(USER_MESSAGES.ROLES_PERMISSIONS)
  permissions() {
    return this.run(() => this.roles.permissions());
  }

  @MessagePattern(USER_MESSAGES.ROLES_MATRIX)
  matrix(@Payload() data: { actor: ActorContext }) {
    return this.run(() => this.roles.matrix(data.actor));
  }

  @MessagePattern(USER_MESSAGES.ROLES_SET_PERMISSIONS)
  setPermissions(
    @Payload() data: { actor: ActorContext; roleKey: string; permissionKeys: string[] },
  ) {
    return this.run(() => this.roles.setRolePermissions(data.actor, data.roleKey, data.permissionKeys));
  }
}
