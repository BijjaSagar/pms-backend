import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { RequirePermissions } from '../common/decorators/access.decorator.js';
import { GuestsService } from './guests.service.js';
import type { AuthenticatedRequest } from '../common/guards/auth.guard.js';

class GuestDto {
  @IsString() @MaxLength(100) firstName: string;
  @IsString() @MaxLength(100) lastName: string;
  @IsOptional() @IsString() @MaxLength(320) email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(200) companyName?: string;
  @IsOptional() @IsString() @MaxLength(200) addressLine1?: string;
  @IsOptional() @IsString() @MaxLength(200) addressLine2?: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @IsString() @MaxLength(100) region?: string;
  @IsOptional() @IsString() @MaxLength(30) postalCode?: string;
  @IsOptional() @IsString() @MaxLength(2) countryCode?: string;
  @IsOptional() @IsString() @MaxLength(4000) preferences?: string;
  @IsOptional() @IsString() @MaxLength(4000) internalNotes?: string;
}

@Controller('guests')
export class GuestsController {
  constructor(private readonly guests: GuestsService) {}

  @RequirePermissions('guest.read')
  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const n = (v: string | undefined, fallback: number) => {
      const parsed = Number(v);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
    };
    return this.guests.list(req, {
      search: search?.trim() || undefined,
      page: n(page, 1),
      pageSize: n(pageSize, 25),
    });
  }

  @RequirePermissions('guest.create')
  @Post()
  create(@Body() dto: GuestDto, @Req() req: AuthenticatedRequest) {
    return this.guests.create(req, dto);
  }

  @RequirePermissions('guest.read')
  @Get(':id')
  get(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.guests.get(req, id);
  }

  @RequirePermissions('guest.update')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: Partial<GuestDto>,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.guests.update(req, id, dto);
  }
}