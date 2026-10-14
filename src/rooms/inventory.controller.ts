import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { RequirePermissions } from '../common/decorators/access.decorator.js';
import { db } from '../prisma/db.js';
import { brand, json } from '../prisma/compat.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedRequest } from '../common/guards/auth.guard.js';

class CreateRoomTypeDto {
  @IsString() @MaxLength(40)
  code: string;

  @IsString() @MaxLength(120)
  name: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @IsInt() @Min(1) maxAdults = 2;
  @IsInt() @Min(0) maxChildren = 0;
  @IsNumber() @Min(0) baseRate = 0;

  @IsOptional()
  amenities?: Record<string, unknown>;
}

class UpdateRoomTypeDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsInt() @Min(1) maxAdults?: number;
  @IsOptional() @IsInt() @Min(0) maxChildren?: number;
  @IsOptional() @IsNumber() @Min(0) baseRate?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() amenities?: Record<string, unknown>;
}

class CreateRoomDto {
  @IsString() @MaxLength(40) roomTypeId: string;
  @IsString() @MaxLength(30) roomNumber: string;
  @IsOptional() @IsString() @MaxLength(30) floor?: string;
  @IsOptional() @IsString() @MaxLength(50) wing?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

class UpdateRoomDto {
  @IsOptional() @IsString() @MaxLength(40) roomTypeId?: string;
  @IsOptional() @IsString() @MaxLength(30) roomNumber?: string;
  @IsOptional() @IsString() @MaxLength(30) floor?: string;
  @IsOptional() @IsString() @MaxLength(50) wing?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Controller()
export class InventoryController {
  constructor(private readonly audit: AuditService) {}

  private activeProperty(req: AuthenticatedRequest): string {
    const p = req.user!.activePropertyId;
    if (!p) throw new Error('no active property');
    return p;
  }

  // ---------------- Room types ----------------

  @RequirePermissions('room.read')
  @Get('room-types')
  async listRoomTypes(@Req() req: AuthenticatedRequest) {
    const rows = await db.orm.public.RoomType
      .where({ propertyId: brand(this.activeProperty(req)) })
      .all();
    return rows
      .map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        description: r.description,
        maxAdults: r.maxAdults,
        maxChildren: r.maxChildren,
        baseOccupancy: r.baseOccupancy,
        baseRate: String(r.baseRate),
        amenities: r.amenities,
        isActive: r.isActive,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  @RequirePermissions('room.create')
  @Post('room-types')
  async createRoomType(@Body() dto: CreateRoomTypeDto, @Req() req: AuthenticatedRequest) {
    const propertyId = this.activeProperty(req);
    const created = await db.orm.public.RoomType.create({
      propertyId: brand(propertyId),
      code: brand(dto.code.toUpperCase()),
      name: brand(dto.name),
      description: brand(dto.description ?? null),
      maxAdults: brand(dto.maxAdults),
      maxChildren: brand(dto.maxChildren),
      baseOccupancy: brand(dto.maxAdults),
      baseRate: brand(String(dto.baseRate)),
      amenities: json(dto.amenities ?? null),
      isActive: brand(true),
    });
    await this.audit.record({
      organizationId: req.user!.organizationId,
      propertyId,
      actorUserId: req.user!.id,
      action: 'room_type.create',
      resourceType: 'RoomType',
      resourceId: created.id,
      outcome: 'SUCCESS',
    });
    return { id: created.id, code: created.code, name: created.name };
  }

  @RequirePermissions('room.update')
  @Patch('room-types/:id')
  async updateRoomType(
    @Param('id') id: string,
    @Body() dto: UpdateRoomTypeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const propertyId = this.activeProperty(req);
    const existing = await db.orm.public.RoomType.where({ id: brand(id) }).first();
    // Scoped lookup: a valid id belonging to another property is treated as absent.
    if (!existing || existing.propertyId !== propertyId) return { notFound: true };

    const patch: Record<string, never> = {};
    if (dto.name !== undefined) patch['name'] = brand(dto.name);
    if (dto.description !== undefined) patch['description'] = brand(dto.description);
    if (dto.maxAdults !== undefined) patch['maxAdults'] = brand(dto.maxAdults);
    if (dto.maxChildren !== undefined) patch['maxChildren'] = brand(dto.maxChildren);
    if (dto.baseRate !== undefined) patch['baseRate'] = brand(String(dto.baseRate));
    if (dto.isActive !== undefined) patch['isActive'] = brand(dto.isActive);
    if (dto.amenities !== undefined) patch['amenities'] = json(dto.amenities);

    const updated = await db.orm.public.RoomType.where({ id: brand(id) }).update(patch);
    if (!updated) return { notFound: true };
    await this.audit.record({
      organizationId: req.user!.organizationId,
      propertyId,
      actorUserId: req.user!.id,
      action: 'room_type.update',
      resourceType: 'RoomType',
      resourceId: id,
      outcome: 'SUCCESS',
      metadata: { changedFields: Object.keys(dto) },
    });
    return { id: updated.id, code: updated.code, name: updated.name, isActive: updated.isActive };
  }

  // ---------------- Rooms ----------------

  @RequirePermissions('room.read')
  @Get('rooms')
  async listRooms(@Req() req: AuthenticatedRequest) {
    const propertyId = this.activeProperty(req);
    const rooms = await db.orm.public.Room.where({ propertyId: brand(propertyId) }).all();
    if (rooms.length === 0) return [];

    const types = await db.orm.public.RoomType
      .where((m) => m.id.in([...new Set(rooms.map((r) => r.roomTypeId))]))
      .all();
    const typeById = new Map(types.map((t) => [t.id, t]));

    return rooms
      .map((r) => ({
        id: r.id,
        roomNumber: r.roomNumber,
        floor: r.floor,
        wing: r.wing,
        status: r.status,
        notes: r.notes,
        isActive: r.isActive,
        roomTypeId: r.roomTypeId,
        roomTypeCode: typeById.get(r.roomTypeId)?.code ?? null,
        roomTypeName: typeById.get(r.roomTypeId)?.name ?? null,
      }))
      .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber));
  }

  @RequirePermissions('room.create')
  @Post('rooms')
  async createRoom(@Body() dto: CreateRoomDto, @Req() req: AuthenticatedRequest) {
    const propertyId = this.activeProperty(req);

    // The room's type must belong to the same property, otherwise a caller could
    // reference another tenant's type by id.
    const type = await db.orm.public.RoomType.where({ id: brand(dto.roomTypeId) }).first();
    if (!type || type.propertyId !== propertyId) {
      return { error: 'room_type_not_in_property' };
    }

    const created = await db.orm.public.Room.create({
      propertyId: brand(propertyId),
      roomTypeId: brand(dto.roomTypeId),
      roomNumber: brand(dto.roomNumber),
      floor: brand(dto.floor ?? null),
      wing: brand(dto.wing ?? null),
      notes: brand(dto.notes ?? null),
      status: brand('VACANT_DIRTY'),
      isActive: brand(true),
    });
    await this.audit.record({
      organizationId: req.user!.organizationId,
      propertyId,
      actorUserId: req.user!.id,
      action: 'room.create',
      resourceType: 'Room',
      resourceId: created.id,
      outcome: 'SUCCESS',
    });
    return { id: created.id, roomNumber: created.roomNumber };
  }

  /**
   * Rooms with history are never hard-deleted; isActive=false retires a room so
   * past stays, folios and housekeeping tasks keep their references intact.
   */
  @RequirePermissions('room.update')
  @Patch('rooms/:id')
  async updateRoom(
    @Param('id') id: string,
    @Body() dto: UpdateRoomDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const propertyId = this.activeProperty(req);
    const existing = await db.orm.public.Room.where({ id: brand(id) }).first();
    if (!existing || existing.propertyId !== propertyId) return { notFound: true };

    if (dto.roomTypeId !== undefined) {
      const type = await db.orm.public.RoomType.where({ id: brand(dto.roomTypeId) }).first();
      if (!type || type.propertyId !== propertyId) {
        return { error: 'room_type_not_in_property' };
      }
    }

    const patch: Record<string, never> = {};
    if (dto.roomTypeId !== undefined) patch['roomTypeId'] = brand(dto.roomTypeId);
    if (dto.roomNumber !== undefined) patch['roomNumber'] = brand(dto.roomNumber);
    if (dto.floor !== undefined) patch['floor'] = brand(dto.floor);
    if (dto.wing !== undefined) patch['wing'] = brand(dto.wing);
    if (dto.notes !== undefined) patch['notes'] = brand(dto.notes);
    if (dto.isActive !== undefined) patch['isActive'] = brand(dto.isActive);

    const updated = await db.orm.public.Room.where({ id: brand(id) }).update(patch);
    if (!updated) return { notFound: true };
    await this.audit.record({
      organizationId: req.user!.organizationId,
      propertyId,
      actorUserId: req.user!.id,
      action: 'room.update',
      resourceType: 'Room',
      resourceId: id,
      outcome: 'SUCCESS',
      metadata: { changedFields: Object.keys(dto), retired: dto.isActive === false },
    });
    return { id: updated.id, roomNumber: updated.roomNumber, isActive: updated.isActive };
  }
}