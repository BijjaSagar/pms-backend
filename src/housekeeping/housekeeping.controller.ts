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
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { RequirePermissions } from '../common/decorators/access.decorator.js';
import type { AuthenticatedRequest } from '../common/guards/auth.guard.js';
import { HousekeepingService } from './housekeeping.service.js';
import { MaintenanceService } from '../maintenance/maintenance.service.js';

class CreateTaskDto {
  @IsUUID() roomId: string;
  @IsString() type: string;
  @IsOptional() @IsString() priority?: string;
  @IsOptional() @IsUUID() assignedToId?: string;
  @IsOptional() @IsISO8601({ strict: true }) dueAt?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

class AssignTaskDto {
  @IsOptional() @IsUUID() assignedToId?: string | null;
}

class NotesDto {
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

class ReasonDto {
  @IsString() @MaxLength(1000) reason: string;
}

class InspectDto {
  @IsIn(['pass', 'fail']) result: 'pass' | 'fail';
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

class CreateTicketDto {
  @IsString() @MaxLength(200) title: string;
  @IsString() @MaxLength(4000) description: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() priority?: string;
}

class AssignTicketDto {
  @IsOptional() @IsUUID() assignedToId?: string | null;
}

class ResolveDto {
  @IsString() @MaxLength(4000) resolution: string;
}

class CloseDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

class OutOfOrderDto {
  @IsString() @MaxLength(1000) reason: string;
}

@Controller()
export class HousekeepingController {
  constructor(
    private readonly hk: HousekeepingService,
    private readonly mx: MaintenanceService,
  ) {}

  @RequirePermissions('housekeeping.read')
  @Get('housekeeping/tasks')
  tasks(@Req() req: AuthenticatedRequest, @Query('scope') scope?: string) {
    return this.hk.list(req, { scope });
  }

  @RequirePermissions('housekeeping.read')
  @Get('housekeeping/summary')
  summary(@Req() req: AuthenticatedRequest) {
    return this.hk.boardSummary(req);
  }

  /**
   * Creation is gated on `housekeeping.assign` rather than a `create` key: the
   * catalog has none, and scheduling is a supervisor's job. Cleaners hold
   * `start`, `complete` and `inspect` and work what they are given.
   */
  @RequirePermissions('housekeeping.assign')
  @Post('housekeeping/tasks')
  createTask(@Body() dto: CreateTaskDto, @Req() req: AuthenticatedRequest) {
    return this.hk.create(req, dto);
  }

  @RequirePermissions('housekeeping.assign')
  @Patch('housekeeping/tasks/:id/assign')
  assignTask(
    @Param('id') id: string,
    @Body() dto: AssignTaskDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.hk.assign(req, id, dto.assignedToId ?? null);
  }

  @RequirePermissions('housekeeping.start')
  @Post('housekeeping/tasks/:id/start')
  startTask(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.hk.start(req, id);
  }

  @RequirePermissions('housekeeping.complete')
  @Post('housekeeping/tasks/:id/complete')
  completeTask(@Param('id') id: string, @Body() dto: NotesDto, @Req() req: AuthenticatedRequest) {
    return this.hk.complete(req, id, dto.notes);
  }

  /**
   * The kit's state machine runs CLEANED -> INSPECTION_REQUIRED -> READY, but
   * its endpoint list has no way to make that first hop and its UI lists
   * "request inspection" as an action. This is that missing transition.
   */
  @RequirePermissions('housekeeping.complete')
  @Post('housekeeping/tasks/:id/request-inspection')
  requestInspection(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.hk.requestInspection(req, id);
  }

  @RequirePermissions('housekeeping.inspect')
  @Post('housekeeping/tasks/:id/inspect')
  inspectTask(@Param('id') id: string, @Body() dto: InspectDto, @Req() req: AuthenticatedRequest) {
    return this.hk.inspect(req, id, dto.result, dto.notes);
  }

  @RequirePermissions('housekeeping.complete')
  @Post('housekeeping/tasks/:id/block')
  blockTask(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: AuthenticatedRequest) {
    return this.hk.block(req, id, dto.reason);
  }

  /** Releases a blocked task back to the floor without cancelling it. */
  @RequirePermissions('housekeeping.complete')
  @Post('housekeeping/tasks/:id/unblock')
  unblockTask(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.hk.unblock(req, id);
  }

  @RequirePermissions('housekeeping.assign')
  @Post('housekeeping/tasks/:id/cancel')
  cancelTask(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: AuthenticatedRequest) {
    return this.hk.cancel(req, id, dto.reason);
  }

  // ------------------------------------------------------------------ maintenance

  @RequirePermissions('maintenance.read')
  @Get('maintenance/tickets')
  tickets(
    @Req() req: AuthenticatedRequest,
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('mine') mine?: string,
  ) {
    return this.mx.list(req, { status, priority, mine: mine === 'true' });
  }

  @RequirePermissions('maintenance.create')
  @Post('maintenance/tickets')
  createTicket(@Body() dto: CreateTicketDto, @Req() req: AuthenticatedRequest) {
    return this.mx.create(req, dto);
  }

  @RequirePermissions('maintenance.assign')
  @Patch('maintenance/tickets/:id/assign')
  assignTicket(
    @Param('id') id: string,
    @Body() dto: AssignTicketDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.mx.assign(req, id, dto.assignedToId ?? null);
  }

  @RequirePermissions('maintenance.assign')
  @Post('maintenance/tickets/:id/start')
  startTicket(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.mx.start(req, id);
  }

  @RequirePermissions('maintenance.resolve')
  @Post('maintenance/tickets/:id/resolve')
  resolveTicket(@Param('id') id: string, @Body() dto: ResolveDto, @Req() req: AuthenticatedRequest) {
    return this.mx.resolve(req, id, dto.resolution);
  }

  @RequirePermissions('maintenance.resolve')
  @Post('maintenance/tickets/:id/close')
  closeTicket(@Param('id') id: string, @Body() dto: CloseDto, @Req() req: AuthenticatedRequest) {
    return this.mx.close(req, id, dto.reason);
  }

  @RequirePermissions('maintenance.resolve')
  @Post('maintenance/tickets/:id/reopen')
  reopenTicket(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: AuthenticatedRequest) {
    return this.mx.reopen(req, id, dto.reason);
  }

  // ------------------------------------------------------------------ out of order

  @RequirePermissions('room.out-of-order')
  @Post('rooms/:id/out-of-order')
  outOfOrder(@Param('id') id: string, @Body() dto: OutOfOrderDto, @Req() req: AuthenticatedRequest) {
    return this.mx.setOutOfOrder(req, id, dto.reason, false);
  }

  @RequirePermissions('room.out-of-order')
  @Post('rooms/:id/back-in-service')
  backInService(@Param('id') id: string, @Body() dto: OutOfOrderDto, @Req() req: AuthenticatedRequest) {
    return this.mx.setOutOfOrder(req, id, dto.reason, true);
  }
}