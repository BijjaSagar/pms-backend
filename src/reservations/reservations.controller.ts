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
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { RequirePermissions } from '../common/decorators/access.decorator.js';
import { ReservationsService } from './reservations.service.js';
import type { AuthenticatedRequest } from '../common/guards/auth.guard.js';

class CreateReservationDto {
  @IsString() primaryGuestId: string;
  @IsISO8601({ strict: true }) checkInDate: string;
  @IsISO8601({ strict: true }) checkOutDate: string;
  @IsInt() @Min(1) adults: number;
  @IsInt() @Min(0) children: number;
  @IsString() roomTypeId: string;
  @IsOptional() @IsString() roomId?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsString() @MaxLength(4000) specialRequests?: string;
}

class AmendReservationDto {
  @IsOptional() @IsISO8601({ strict: true }) checkInDate?: string;
  @IsOptional() @IsISO8601({ strict: true }) checkOutDate?: string;
  @IsOptional() @IsInt() @Min(1) adults?: number;
  @IsOptional() @IsInt() @Min(0) children?: number;
  @IsOptional() @IsString() @MaxLength(4000) specialRequests?: string;
  // Declared so class-validator reports "unknown property" rather than the
  // request silently slipping through the allow-list.
  @IsOptional() @IsString() status?: string;
}

class CancelReservationDto {
  @IsString() @MaxLength(1000) reason: string;
}

class AssignRoomDto {
  @IsString() roomId: string;
}

@Controller()
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @RequirePermissions('reservation.read')
  @Get('reservations')
  list(
    @Req() req: AuthenticatedRequest,
    @Query('status') status?: string,
    @Query('checkIn') checkIn?: string,
    @Query('checkOut') checkOut?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const positiveInt = (v: string | undefined, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
    };
    return this.reservations.list(req, {
      status,
      checkIn,
      checkOut,
      search: search?.trim() || undefined,
      page: positiveInt(page, 1),
      pageSize: positiveInt(pageSize, 25),
    });
  }

  @RequirePermissions('reservation.read')
  @Get('availability')
  availability(
    @Req() req: AuthenticatedRequest,
    @Query('checkIn') checkIn?: string,
    @Query('checkOut') checkOut?: string,
    @Query('roomTypeId') roomTypeId?: string,
  ) {
    if (!checkIn || !checkOut || !roomTypeId) {
      return { error: 'checkIn, checkOut and roomTypeId are required' };
    }
    return this.reservations.availability(
      req.user!.activePropertyId!,
      roomTypeId,
      checkIn,
      checkOut,
    );
  }

  @RequirePermissions('reservation.create')
  @Post('reservations')
  create(@Body() dto: CreateReservationDto, @Req() req: AuthenticatedRequest) {
    return this.reservations.create(req, {
      primaryGuestId: dto.primaryGuestId,
      checkInDate: dto.checkInDate,
      checkOutDate: dto.checkOutDate,
      adults: dto.adults,
      children: dto.children,
      roomTypeId: dto.roomTypeId,
      roomId: dto.roomId ?? null,
      source: dto.source ?? 'DIRECT',
      notes: dto.specialRequests ?? null,
    });
  }

  @RequirePermissions('reservation.read')
  @Get('reservations/:id')
  detail(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.reservations.detail(req, id);
  }

  @RequirePermissions('reservation.update')
  @Patch('reservations/:id')
  amend(
    @Param('id') id: string,
    @Body() dto: AmendReservationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.reservations.update(req, id, dto);
  }

  @RequirePermissions('reservation.assign-room')
  @Post('reservations/:id/assign-room')
  assignRoom(
    @Param('id') id: string,
    @Body() dto: AssignRoomDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.reservations.assignRoom(req, id, dto.roomId);
  }

  @RequirePermissions('reservation.cancel')
  @Post('reservations/:id/cancel')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelReservationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.reservations.cancel(req, id, dto.reason);
  }
}