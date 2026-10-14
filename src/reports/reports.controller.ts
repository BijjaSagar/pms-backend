import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { RequirePermissions } from '../common/decorators/access.decorator.js';
import type { AuthenticatedRequest } from '../common/guards/auth.guard.js';
import { ReportsService } from './reports.service.js';
import { NightAuditService } from '../night-audit/night-audit.service.js';
import { toCsv } from './csv.js';

class CloseDto {
  @IsString() @MaxLength(120) idempotencyKey: string;
}

class ReopenDto {
  @IsString() @MaxLength(1000) reason: string;
}

/**
 * Reports.
 *
 * Financial figures sit behind `report.read.financial`, which Front Desk does
 * not hold; exports additionally require `report.export`. The daily flash and
 * movement reports are operational and stay on `report.read.operations`.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermissions('report.read.operations')
  @Get('daily-flash')
  dailyFlash(@Req() req: AuthenticatedRequest, @Query('date') date?: string) {
    return this.reports.dailyFlash(req, date);
  }

  @RequirePermissions('report.read.operations')
  @Get('occupancy')
  occupancy(@Req() req: AuthenticatedRequest, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.occupancy(req, from, to);
  }

  @RequirePermissions('report.read.financial')
  @Get('revenue')
  revenue(@Req() req: AuthenticatedRequest, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.revenue(req, from, to);
  }

  @RequirePermissions('report.read.operations')
  @Get('arrivals-departures')
  movement(@Req() req: AuthenticatedRequest, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.arrivalsDepartures(req, from, to);
  }

  /** §8.3 asks for a housekeeping performance report that §8.1 never specifies. */
  @RequirePermissions('report.read.operations')
  @Get('housekeeping')
  housekeeping(@Req() req: AuthenticatedRequest, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.housekeeping(req, from, to);
  }

  // ------------------------------------------------------------------- exports

  @RequirePermissions('report.read.operations', 'report.export')
  @Get('daily-flash/export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportDailyFlash(@Req() req: AuthenticatedRequest, @Res() res: any, @Query('date') date?: string) {
    const d = await this.reports.dailyFlash(req, date);
    const csv = toCsv(
      ['section', 'bookingCode', 'guest', 'room', 'dates', 'status'],
      [
        ...d.arrivals.map((a: any) => ['Arrival', a.bookingCode, a.guestName, '', a.checkOutDate, 'CONFIRMED']),
        ...d.departures.map((x: any) => ['Departure', x.bookingCode, x.guestName, '', x.checkInDate, 'CHECKED_IN']),
      ],
    );
    res.setHeader('Content-Disposition', `attachment; filename="daily-flash-${d.businessDate}.csv"`);
    res.send(csv);
  }

  @RequirePermissions('report.read.financial', 'report.export')
  @Get('revenue/export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportRevenue(@Req() req: AuthenticatedRequest, @Res() res: any, @Query('from') from?: string, @Query('to') to?: string) {
    const d = await this.reports.revenue(req, from, to);
    const csv = toCsv(
      ['metric', 'value'],
      [
        ['from', d.from],
        ['to', d.to],
        ['currency', d.currencyCode],
        ['roomRevenue', d.roomRevenue],
        ['otherRevenue', d.otherRevenue],
        ['taxTotal', d.taxTotal],
        ['grossRevenue', d.grossRevenue],
        ['paymentsCollected', d.paymentsCollected],
        ['paymentsRefunded', d.paymentsRefunded],
        ['paymentsNetCollected', d.paymentsNetCollected],
        ['soldRoomNights', d.soldRoomNights],
        ['availableRoomNights', d.availableRoomNights],
        ['ADR', d.adr],
        ['RevPAR', d.revpar],
      ],
    );
    res.setHeader('Content-Disposition', `attachment; filename="revenue-${d.from}_${d.to}.csv"`);
    res.send(csv);
  }

  @RequirePermissions('report.read.operations', 'report.export')
  @Get('arrivals-departures/export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportMovement(@Req() req: AuthenticatedRequest, @Res() res: any, @Query('from') from?: string, @Query('to') to?: string) {
    const d = await this.reports.arrivalsDepartures(req, from, to);
    const csv = toCsv(
      ['bookingCode', 'guest', 'status', 'checkIn', 'checkOut', 'nights', 'room', 'nightlyRate', 'folioNo'],
      d.rows.map((r: any) => [
        r.bookingCode, r.guestName, r.status, r.checkInDate, r.checkOutDate,
        r.nights, r.roomNumber, r.nightlyRate, r.folioNo,
      ]),
    );
    res.setHeader('Content-Disposition', `attachment; filename="movement-${d.from}_${d.to}.csv"`);
    res.send(csv);
  }

  @RequirePermissions('report.read.operations', 'report.export')
  @Get('occupancy/export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportOccupancy(@Req() req: AuthenticatedRequest, @Res() res: any, @Query('from') from?: string, @Query('to') to?: string) {
    const d = await this.reports.occupancy(req, from, to);
    const csv = toCsv(
      ['metric', 'value'],
      [
        ['from', d.from], ['to', d.to], ['nights', d.nights], ['rooms', d.rooms],
        ['availableRoomNights', d.availableRoomNights], ['soldRoomNights', d.soldRoomNights],
        ['unsoldRoomNights', d.unsoldRoomNights], ['occupancyPct', d.occupancyPct],
      ],
    );
    res.setHeader('Content-Disposition', `attachment; filename="occupancy-${d.from}_${d.to}.csv"`);
    res.send(csv);
  }
}

@Controller('night-audit')
export class NightAuditController {
  constructor(private readonly nightAudit: NightAuditService) {}

  @RequirePermissions('night-audit.read')
  @Get(':businessDate')
  get(@Param('businessDate') businessDate: string, @Req() req: AuthenticatedRequest) {
    return this.nightAudit.get(req, businessDate);
  }

  @RequirePermissions('night-audit.run')
  @Post(':businessDate/preview')
  preview(@Param('businessDate') businessDate: string, @Req() req: AuthenticatedRequest) {
    return this.nightAudit.preview(req, businessDate);
  }

  @RequirePermissions('night-audit.approve')
  @Post(':businessDate/close')
  close(
    @Param('businessDate') businessDate: string,
    @Body() dto: CloseDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.nightAudit.close(req, businessDate, dto.idempotencyKey);
  }

  /**
   * REOPENED is in the enum and in the kit's state machine but has no listed
   * endpoint, the same gap as task inspection and ticket closing.
   */
  @RequirePermissions('night-audit.approve')
  @Post(':businessDate/reopen')
  reopen(
    @Param('businessDate') businessDate: string,
    @Body() dto: ReopenDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.nightAudit.reopen(req, businessDate, dto.reason);
  }
}