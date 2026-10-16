import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RequirePermissions } from '../common/decorators/access.decorator.js';
import { BookingClientService } from '../booking-client/booking-client.service.js';
import { HOLD_MESSAGES, RESERVATION_MESSAGES } from '../contracts/booking.messages.js';
import type { ActorContext } from '../contracts/shared.js';
import type { AuthenticatedRequest } from '../common/guards/auth.guard.js';

export class ReservationExtraDto {
  @IsString() @MaxLength(200) name: string;
  @IsIn(['per_night', 'per_stay', 'per_guest', 'per_room']) chargeUnit: 'per_night' | 'per_stay' | 'per_guest' | 'per_room';
  @IsNumber() quantity: number;
  @IsString() unitRate: string;
  @IsOptional() @IsBoolean() taxable?: boolean;
}

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
  /** The selection-time hold to convert, when the user picked a room. */
  @IsOptional() @IsString() @MaxLength(120) holdId?: string;
  /** Makes a retried create idempotent: a replay returns the same booking. */
  @IsOptional() @IsString() @MaxLength(120) idempotencyKey?: string;
  /** Optional extras/additions agreed at booking time. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReservationExtraDto)
  extras?: ReservationExtraDto[];
  /** Optional discount applied to the reservation. */
  @IsOptional()
  @IsString()
  discount?: string;
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

class HoldDto {
  @IsString() roomId: string;
  @IsISO8601({ strict: true }) checkIn: string;
  @IsISO8601({ strict: true }) checkOut: string;
}

/**
 * Reservation and availability surface.
 *
 * Thin over the booking microservice: it validates the HTTP body, packages the
 * authenticated actor, and forwards. Room holds are the selection-time lock
 * that keeps two users from picking the same room-night.
 */
@Controller()
export class ReservationsController {
  constructor(private readonly booking: BookingClientService) {}

  private actor(req: AuthenticatedRequest): ActorContext {
    const user = req.user!;
    return {
      id: user.id,
      organizationId: user.organizationId,
      activePropertyId: user.activePropertyId,
      permissions: user.permissions,
    };
  }

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
    return this.booking.request(RESERVATION_MESSAGES.LIST, {
      actor: this.actor(req),
      opts: {
        status,
        checkIn,
        checkOut,
        search: search?.trim() || undefined,
        page: positiveInt(page, 1),
        pageSize: positiveInt(pageSize, 25),
      },
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
    return this.booking.request(RESERVATION_MESSAGES.AVAILABILITY, {
      actor: this.actor(req),
      roomTypeId,
      checkIn,
      checkOut,
    });
  }

  /** Reserves every night for this user the moment a room is selected. */
  @RequirePermissions('reservation.create')
  @Post('availability/hold')
  hold(@Body() dto: HoldDto, @Req() req: AuthenticatedRequest) {
    return this.booking.request(HOLD_MESSAGES.ACQUIRE, {
      actor: this.actor(req),
      roomId: dto.roomId,
      checkIn: dto.checkIn,
      checkOut: dto.checkOut,
    });
  }

  @RequirePermissions('reservation.create')
  @Post('availability/holds/:holdId/refresh')
  refreshHold(@Param('holdId') holdId: string, @Req() req: AuthenticatedRequest) {
    return this.booking.request(HOLD_MESSAGES.REFRESH, { actor: this.actor(req), holdId });
  }

  @RequirePermissions('reservation.create')
  @Delete('availability/holds/:holdId')
  releaseHold(@Param('holdId') holdId: string, @Req() req: AuthenticatedRequest) {
    return this.booking.request(HOLD_MESSAGES.RELEASE, { actor: this.actor(req), holdId });
  }

  @RequirePermissions('reservation.create')
  @Post('reservations')
  create(@Body() dto: CreateReservationDto, @Req() req: AuthenticatedRequest) {
    return this.booking.request(RESERVATION_MESSAGES.CREATE, {
      actor: this.actor(req),
      input: {
        primaryGuestId: dto.primaryGuestId,
        checkInDate: dto.checkInDate,
        checkOutDate: dto.checkOutDate,
        adults: dto.adults,
        children: dto.children,
        roomTypeId: dto.roomTypeId,
        roomId: dto.roomId ?? null,
        source: dto.source ?? 'DIRECT',
        notes: dto.specialRequests ?? null,
        holdId: dto.holdId ?? null,
        idempotencyKey: dto.idempotencyKey ?? null,
      },
    });
  }

  @RequirePermissions('reservation.read')
  @Get('reservations/:id')
  detail(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.booking.request(RESERVATION_MESSAGES.DETAIL, { actor: this.actor(req), id });
  }

  @RequirePermissions('reservation.update')
  @Patch('reservations/:id')
  amend(
    @Param('id') id: string,
    @Body() dto: AmendReservationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.booking.request(RESERVATION_MESSAGES.UPDATE, {
      actor: this.actor(req),
      id,
      body: dto,
    });
  }

  @RequirePermissions('reservation.assign-room')
  @Post('reservations/:id/assign-room')
  assignRoom(
    @Param('id') id: string,
    @Body() dto: AssignRoomDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.booking.request(RESERVATION_MESSAGES.ASSIGN_ROOM, {
      actor: this.actor(req),
      id,
      roomId: dto.roomId,
    });
  }

  @RequirePermissions('reservation.cancel')
  @Post('reservations/:id/cancel')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelReservationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.booking.request(RESERVATION_MESSAGES.CANCEL, {
      actor: this.actor(req),
      id,
      reason: dto.reason,
    });
  }
}
