import { Controller, Get, Header, Query, Req, Res } from '@nestjs/common';
import { RequirePermissions } from '../common/decorators/access.decorator.js';
import type { AuthenticatedRequest } from '../common/guards/auth.guard.js';
import { AuditLogService } from './audit-log.service.js';

/**
 * Read-only audit trail.
 *
 * Only GET exists here. An audit log with an update or delete route is not an
 * audit log, so the absence is the feature rather than an omission.
 */
@Controller('audit-log')
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @RequirePermissions('audit-log.read')
  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('actorUserId') actorUserId?: string,
    @Query('action') action?: string,
    @Query('resourceType') resourceType?: string,
    @Query('resourceId') resourceId?: string,
    @Query('outcome') outcome?: string,
    @Query('limit') limit?: string,
  ) {
    return this.auditLog.list(req, {
      from, to, actorUserId, action, resourceType, resourceId, outcome,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @RequirePermissions('audit-log.read')
  @Get('actions')
  actions(@Req() req: AuthenticatedRequest) {
    return this.auditLog.actions(req);
  }

  /** `audit-log.export` is Admin-only in the catalog, which is the right gate. */
  @RequirePermissions('audit-log.export')
  @Get('export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportCsv(@Req() req: AuthenticatedRequest, @Res() res: any, @Query('from') from?: string, @Query('to') to?: string) {
    const csv = await this.auditLog.exportCsv(req, { from, to });
    res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
    res.send(csv);
  }
}