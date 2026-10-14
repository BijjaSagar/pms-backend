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
import { UsersService } from './users.service.js';
import { RolesService, TaxRulesService } from './roles.service.js';

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

@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly roles: RolesService,
    private readonly tax: TaxRulesService,
  ) {}

  // -------------------------------------------------------------------- staff

  /** Manager and Admin can see the staff list; neither can change it here. */
  @RequirePermissions('user.read')
  @Get('users')
  list(@Req() req: AuthenticatedRequest) {
    return this.users.list(req);
  }

  @RequirePermissions('user.read')
  @Get('users/:id')
  get(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.users.get(req, id);
  }

  @RequirePermissions('user.invite')
  @Post('users/invite')
  invite(@Body() dto: InviteDto, @Req() req: AuthenticatedRequest) {
    return this.users.invite(req, dto);
  }

  @RequirePermissions('user.invite')
  @Post('users/:id/reissue-invite')
  reissue(@Param('id') id: string, @Body() dto: ReissueDto, @Req() req: AuthenticatedRequest) {
    return this.users.reissueInvite(req, id, dto.expiresAt ?? null);
  }

  @RequirePermissions('user.invite')
  @Post('users/:id/cancel-invite')
  cancel(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.users.cancelInvite(req, id);
  }

  /**
   * Unauthenticated by necessity: the invite token is the credential. There is
   * no session to check, and requiring one would make it impossible for someone
   * who has never logged in to activate their account.
   */
  @Public()
  @Post('users/accept-invite')
  accept(@Body() dto: AcceptDto) {
    return this.users.acceptInvite(dto.token, dto.password);
  }

  @RequirePermissions('user.update')
  @Patch('users/:id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @Req() req: AuthenticatedRequest) {
    return this.users.updateProfile(req, id, dto);
  }

  @RequirePermissions('role.assign')
  @Patch('users/:id/role')
  setRole(@Param('id') id: string, @Body() dto: SetRoleDto, @Req() req: AuthenticatedRequest) {
    return this.users.setRole(req, id, dto.propertyId, dto.roleKey);
  }

  @RequirePermissions('user.deactivate')
  @Patch('users/:id/status')
  setStatus(@Param('id') id: string, @Body() dto: SetStatusDto, @Req() req: AuthenticatedRequest) {
    return this.users.setStatus(req, id, dto.status);
  }

  // -------------------------------------------------------------------- roles

  @RequirePermissions('role.read')
  @Get('roles')
  roles_(@Req() req: AuthenticatedRequest) {
    return this.roles.list(req);
  }

  @RequirePermissions('role.read')
  @Get('permissions')
  permissions() {
    return this.roles.permissions();
  }

  @RequirePermissions('role.read')
  @Get('roles/matrix')
  matrix(@Req() req: AuthenticatedRequest) {
    return this.roles.matrix(req);
  }

  @RequirePermissions('role.manage')
  @Patch('roles/:key/permissions')
  setPermissions(@Param('key') key: string, @Body() dto: SetPermissionsDto, @Req() req: AuthenticatedRequest) {
    return this.roles.setRolePermissions(req, key, dto.permissionKeys);
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