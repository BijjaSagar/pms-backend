import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Public, RequirePermissions } from '../common/decorators/access.decorator.js';
import type { AuthenticatedRequest } from '../common/guards/auth.guard.js';
import { AuthClientService } from '../auth-client/auth-client.service.js';
import { USER_MESSAGES, type ActorContext } from '../contracts/auth.messages.js';
import { TaxRulesService } from './tax-rules.service.js';

class InviteDto {
  @IsString() @MaxLength(320) email: string;
  @IsString() @MaxLength(200) fullName: string;
  @IsString() @MaxLength(60) roleKey: string;
  @IsOptional() @IsUUID() propertyId?: string;
  @IsOptional() @IsISO8601({ strict: true }) expiresAt?: string;
}

class ReissueDto {
  @IsOptional() @IsISO8601({ strict: true }) expiresAt?: string;
}

class AcceptDto {
  @IsString() @MaxLength(120) token: string;
  /** Minimum matches the service-side check so the two cannot drift. */
  @IsString() @MinLength(12) password: string;
}

class UpdateUserDto {
  @IsOptional() @IsString() @MaxLength(200) fullName?: string;
}

class SetRoleDto {
  @IsUUID() propertyId: string;
  @IsString() @MaxLength(60) roleKey: string;
}

class SetStatusDto {
  @IsIn(['ACTIVE', 'DISABLED']) status: 'ACTIVE' | 'DISABLED';
}

class SetPermissionsDto {
  @IsString({ each: true }) permissionKeys: string[];
}

class TaxRuleDto {
  @IsString() @MaxLength(40) code: string;
  @IsString() @MaxLength(120) name: string;
  @IsNumber() ratePercent: number;
  @IsOptional() @IsString() @MaxLength(40) appliesTo?: string;
  @IsOptional() @IsBoolean() isInclusive?: boolean;
}

class TaxRulePatchDto {
  @IsOptional() @IsNumber() ratePercent?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
}

/**
 * Staff, roles and tax rules.
 *
 * The staff and role handlers are thin: they validate the HTTP body, package the
 * authenticated actor, and forward to the auth microservice. Tax rules are not
 * authorization state and stay local.
 */
@Controller()
export class UsersController {
  constructor(
    private readonly authClient: AuthClientService,
    private readonly tax: TaxRulesService,
  ) {}

  /** The authenticated actor, detached from the request for the transport. */
  private actor(req: AuthenticatedRequest): ActorContext {
    const user = req.user!;
    return {
      id: user.id,
      organizationId: user.organizationId,
      activePropertyId: user.activePropertyId,
      permissions: user.permissions,
    };
  }

  // -------------------------------------------------------------------- staff

  /** Manager and Admin can see the staff list; neither can change it here. */
  @RequirePermissions('user.read')
  @Get('users')
  list(@Req() req: AuthenticatedRequest) {
    return this.authClient.request(USER_MESSAGES.LIST, { actor: this.actor(req) });
  }

  @RequirePermissions('user.read')
  @Get('users/:id')
  get(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.authClient.request(USER_MESSAGES.GET, { actor: this.actor(req), userId: id });
  }

  @RequirePermissions('user.invite')
  @Post('users/invite')
  invite(@Body() dto: InviteDto, @Req() req: AuthenticatedRequest) {
    return this.authClient.request(USER_MESSAGES.INVITE, { actor: this.actor(req), input: dto });
  }

  @RequirePermissions('user.invite')
  @Post('users/:id/reissue-invite')
  reissue(@Param('id') id: string, @Body() dto: ReissueDto, @Req() req: AuthenticatedRequest) {
    return this.authClient.request(USER_MESSAGES.REISSUE_INVITE, {
      actor: this.actor(req),
      userId: id,
      expiresAt: dto.expiresAt ?? null,
    });
  }

  @RequirePermissions('user.invite')
  @Post('users/:id/cancel-invite')
  cancel(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.authClient.request(USER_MESSAGES.CANCEL_INVITE, {
      actor: this.actor(req),
      userId: id,
    });
  }

  /**
   * Unauthenticated by necessity: the invite token is the credential. There is
   * no session to check, and requiring one would make it impossible for someone
   * who has never logged in to activate their account.
   */
  @Public()
  @Post('users/accept-invite')
  accept(@Body() dto: AcceptDto) {
    return this.authClient.request(USER_MESSAGES.ACCEPT_INVITE, {
      token: dto.token,
      password: dto.password,
    });
  }

  @RequirePermissions('user.update')
  @Patch('users/:id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @Req() req: AuthenticatedRequest) {
    return this.authClient.request(USER_MESSAGES.UPDATE, {
      actor: this.actor(req),
      userId: id,
      patch: dto,
    });
  }

  @RequirePermissions('role.assign')
  @Patch('users/:id/role')
  setRole(@Param('id') id: string, @Body() dto: SetRoleDto, @Req() req: AuthenticatedRequest) {
    return this.authClient.request(USER_MESSAGES.SET_ROLE, {
      actor: this.actor(req),
      userId: id,
      propertyId: dto.propertyId,
      roleKey: dto.roleKey,
    });
  }

  @RequirePermissions('user.deactivate')
  @Patch('users/:id/status')
  setStatus(@Param('id') id: string, @Body() dto: SetStatusDto, @Req() req: AuthenticatedRequest) {
    return this.authClient.request(USER_MESSAGES.SET_STATUS, {
      actor: this.actor(req),
      userId: id,
      status: dto.status,
    });
  }

  // -------------------------------------------------------------------- roles

  @RequirePermissions('role.read')
  @Get('roles')
  roles_(@Req() req: AuthenticatedRequest) {
    return this.authClient.request(USER_MESSAGES.ROLES_LIST, { actor: this.actor(req) });
  }

  @RequirePermissions('role.read')
  @Get('permissions')
  permissions() {
    return this.authClient.request(USER_MESSAGES.ROLES_PERMISSIONS, {});
  }

  @RequirePermissions('role.read')
  @Get('roles/matrix')
  matrix(@Req() req: AuthenticatedRequest) {
    return this.authClient.request(USER_MESSAGES.ROLES_MATRIX, { actor: this.actor(req) });
  }

  @RequirePermissions('role.manage')
  @Patch('roles/:key/permissions')
  setPermissions(@Param('key') key: string, @Body() dto: SetPermissionsDto, @Req() req: AuthenticatedRequest) {
    return this.authClient.request(USER_MESSAGES.ROLES_SET_PERMISSIONS, {
      actor: this.actor(req),
      roleKey: key,
      permissionKeys: dto.permissionKeys,
    });
  }

  // ---------------------------------------------------------------- tax rules

  /** Anyone who can read invoices can see the rates they are taxed at. */
  @RequirePermissions('invoice.read')
  @Get('tax-rules')
  taxRules(@Req() req: AuthenticatedRequest) {
    return this.tax.list(req);
  }

  /**
   * Admin only, deliberately not `invoice.issue`. Front Desk holds
   * `invoice.issue`, and a front-desk user able to change GST would alter how
   * every later charge is taxed.
   */
  @RequirePermissions('role.manage')
  @Post('tax-rules')
  createTaxRule(@Body() dto: TaxRuleDto, @Req() req: AuthenticatedRequest) {
    return this.tax.create(req, dto);
  }

  @RequirePermissions('role.manage')
  @Patch('tax-rules/:id')
  patchTaxRule(@Param('id') id: string, @Body() dto: TaxRulePatchDto, @Req() req: AuthenticatedRequest) {
    return this.tax.update(req, id, dto);
  }
}
