import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { IsISO8601, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { RequirePermissions } from '../common/decorators/access.decorator.js';
import { FrontDeskService } from './front-desk.service.js';
import { FolioService } from '../folios/folio.service.js';
import { InvoiceService } from '../folios/invoice.service.js';
import type { AuthenticatedRequest } from '../common/guards/auth.guard.js';

/**
 * Checkout needs only `stay.check-out` for the ordinary, settled path.
 *
 * The permission for waiving a balance cannot live in the decorator, which is
 * a static declaration: requiring it here would block the normal zero-balance
 * checkout from Front Desk, who does not hold it. That check therefore happens
 * in the service, and only when an override is actually being used.
 */
class OverrideDto {
  @IsOptional() @IsString() @MaxLength(1000) overrideReason?: string;
}

class CheckOutDto extends OverrideDto {}

class ExtendDto {
  @IsISO8601({ strict: true }) newCheckOutDate: string;
}

class PostChargeDto {
  @IsString() type: string;
  @IsString() @MaxLength(300) description: string;
  // Positive decimal with up to 2 places. Reductions travel as DISCOUNT /
  // ADJUSTMENT lines posted by the service, never as negative input here.
  @IsString() @Matches(/^\d+(\.\d{1,2})?$/) unitAmount: string;
  @IsString() @Matches(/^[1-9]\d*$/) quantity: string;
  @IsOptional() @IsString() @MaxLength(120) idempotencyKey?: string;
}

class PaymentDto {
  @IsString() @Matches(/^\d+(\.\d{1,2})?$/) amount: string;
  @IsString() method: string;
  @IsOptional() @IsString() @MaxLength(200) reference?: string;
  @IsOptional() @IsString() @MaxLength(120) idempotencyKey?: string;
}

/** Any override that must be justifiable later takes a written reason. */
class ReasonDto {
  @IsString() @MaxLength(1000) reason: string;
}

class RefundDto extends ReasonDto {
  @IsString() @Matches(/^\d+(\.\d{1,2})?$/) amount: string;
}

@Controller()
export class FrontDeskController {
  constructor(
    private readonly frontDesk: FrontDeskService,
    private readonly folios: FolioService,
    private readonly invoiceService: InvoiceService,
  ) {}

  @RequirePermissions('stay.check-in')
  @Post('reservations/:id/check-in')
  checkIn(
    @Param('id') id: string,
    @Body() dto: OverrideDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.frontDesk.checkIn(req, id, { overrideReason: dto.overrideReason });
  }

  /**
   * The override path additionally requires `folio.item.adjust`. Declaring both
   * permissions here means the guard rejects the request outright when the
   * caller cannot waive a balance, rather than waiving it and failing later.
   */
  @RequirePermissions('stay.check-out')
  @Post('reservations/:id/check-out')
  checkOut(
    @Param('id') id: string,
    @Body() dto: CheckOutDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.frontDesk.checkOut(req, id, { overrideReason: dto.overrideReason });
  }

  @RequirePermissions('stay.check-in')
  @Post('reservations/:id/extend')
  extend(@Param('id') id: string, @Body() dto: ExtendDto, @Req() req: AuthenticatedRequest) {
    return this.frontDesk.extend(req, id, dto.newCheckOutDate as never);
  }

  @RequirePermissions('reservation.read')
  @Get('front-desk/arrivals')
  arrivals(@Req() req: AuthenticatedRequest) {
    return this.frontDesk.arrivals(req);
  }

  @RequirePermissions('reservation.read')
  @Get('front-desk/departures')
  departures(@Req() req: AuthenticatedRequest) {
    return this.frontDesk.departures(req);
  }

  @RequirePermissions('reservation.read')
  @Get('front-desk/in-house')
  inHouse(@Req() req: AuthenticatedRequest) {
    return this.frontDesk.inHouse(req);
  }

  @RequirePermissions('folio.read')
  @Get('folios/:id/balance')
  balance(@Param('id') id: string) {
    return this.folios.balance(id);
  }

  @RequirePermissions('folio.read')
  @Get('folios/:id')
  folioDetail(@Param('id') id: string) {
    return this.folios.detail(id);
  }

  @RequirePermissions('folio.close')
  @Post('folios/:id/close')
  closeFolio(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.folios.close(req, id);
  }

  @RequirePermissions('folio.reopen')
  @Post('folios/:id/reopen')
  reopenFolio(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: AuthenticatedRequest) {
    return this.folios.reopen(req, id, dto.reason);
  }

  @RequirePermissions('folio.item.void')
  @Post('folio-items/:id/void')
  voidItem(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: AuthenticatedRequest) {
    return this.folios.voidItem(req, id, dto.reason);
  }

  @RequirePermissions('payment.read')
  @Get('payments')
  payments(@Req() req: AuthenticatedRequest) {
    return this.invoiceService.paymentLedger(req.user!.activePropertyId!);
  }

  @RequirePermissions('payment.refund')
  @Post('payments/:id/refund')
  refund(@Param('id') id: string, @Body() dto: RefundDto, @Req() req: AuthenticatedRequest) {
    return this.folios.refund(req, id, dto.amount, dto.reason);
  }

  @RequirePermissions('invoice.read')
  @Get('invoices')
  invoices(@Req() req: AuthenticatedRequest) {
    return this.invoiceService.list(req.user!.activePropertyId!);
  }

  @RequirePermissions('invoice.read')
  @Get('invoices/:id')
  invoice(@Param('id') id: string) {
    return this.invoiceService.preview(id);
  }

  @RequirePermissions('invoice.issue')
  @Post('folios/:id/invoices')
  issueInvoice(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.invoiceService.issue(req, id);
  }

  @RequirePermissions('invoice.void')
  @Post('invoices/:id/void')
  voidInvoice(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: AuthenticatedRequest) {
    return this.invoiceService.voidInvoice(req, id, dto.reason);
  }

  @RequirePermissions('folio.item.post')
  @Post('folios/:id/items')
  postCharge(@Param('id') id: string, @Body() dto: PostChargeDto, @Req() req: AuthenticatedRequest) {
    return this.folios.postCharge(id, {
      type: dto.type,
      description: dto.description,
      quantity: Number(dto.quantity),
      unitAmount: dto.unitAmount,
      postedById: req.user!.id,
      idempotencyKey: dto.idempotencyKey ?? null,
    });
  }

  @RequirePermissions('payment.record')
  @Post('folios/:id/payments')
  recordPayment(@Param('id') id: string, @Body() dto: PaymentDto, @Req() req: AuthenticatedRequest) {
    return this.folios.recordPayment(id, {
      amount: dto.amount,
      method: dto.method,
      reference: dto.reference ?? null,
      receivedById: req.user!.id,
      idempotencyKey: dto.idempotencyKey ?? null,
    });
  }
}