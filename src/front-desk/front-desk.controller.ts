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
import { BookingClientService } from '../booking-client/booking-client.service.js';
import { FOLIO_MESSAGES, INVOICE_MESSAGES, STAY_MESSAGES } from '../contracts/booking.messages.js';
import type { ActorContext } from '../contracts/shared.js';
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

/**
 * Front-desk, folio and invoice surface.
 *
 * Thin over the booking microservice, like the reservation controller.
 */
@Controller()
export class FrontDeskController {
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

  // --------------------------------------------------------------- stay flow

  @RequirePermissions('stay.check-in')
  @Post('reservations/:id/check-in')
  checkIn(@Param('id') id: string, @Body() dto: OverrideDto, @Req() req: AuthenticatedRequest) {
    return this.booking.request(STAY_MESSAGES.CHECK_IN, {
      actor: this.actor(req),
      id,
      overrideReason: dto.overrideReason,
    });
  }

  /**
   * The override path additionally requires `folio.item.adjust`, enforced in the
   * service so the ordinary zero-balance checkout is not blocked for Front Desk.
   */
  @RequirePermissions('stay.check-out')
  @Post('reservations/:id/check-out')
  checkOut(@Param('id') id: string, @Body() dto: CheckOutDto, @Req() req: AuthenticatedRequest) {
    return this.booking.request(STAY_MESSAGES.CHECK_OUT, {
      actor: this.actor(req),
      id,
      overrideReason: dto.overrideReason,
    });
  }

  @RequirePermissions('stay.check-in')
  @Post('reservations/:id/extend')
  extend(@Param('id') id: string, @Body() dto: ExtendDto, @Req() req: AuthenticatedRequest) {
    return this.booking.request(STAY_MESSAGES.EXTEND, {
      actor: this.actor(req),
      id,
      newCheckOutDate: dto.newCheckOutDate,
    });
  }

  @RequirePermissions('reservation.read')
  @Get('front-desk/arrivals')
  arrivals(@Req() req: AuthenticatedRequest) {
    return this.booking.request(STAY_MESSAGES.ARRIVALS, { actor: this.actor(req) });
  }

  @RequirePermissions('reservation.read')
  @Get('front-desk/departures')
  departures(@Req() req: AuthenticatedRequest) {
    return this.booking.request(STAY_MESSAGES.DEPARTURES, { actor: this.actor(req) });
  }

  @RequirePermissions('reservation.read')
  @Get('front-desk/in-house')
  inHouse(@Req() req: AuthenticatedRequest) {
    return this.booking.request(STAY_MESSAGES.IN_HOUSE, { actor: this.actor(req) });
  }

  // ------------------------------------------------------------------- folios

  @RequirePermissions('folio.read')
  @Get('folios/:id/balance')
  balance(@Param('id') id: string) {
    return this.booking.request(FOLIO_MESSAGES.BALANCE, { folioId: id });
  }

  @RequirePermissions('folio.read')
  @Get('folios/:id')
  folioDetail(@Param('id') id: string) {
    return this.booking.request(FOLIO_MESSAGES.DETAIL, { folioId: id });
  }

  @RequirePermissions('folio.close')
  @Post('folios/:id/close')
  closeFolio(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.booking.request(FOLIO_MESSAGES.CLOSE, { actor: this.actor(req), folioId: id });
  }

  @RequirePermissions('folio.reopen')
  @Post('folios/:id/reopen')
  reopenFolio(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: AuthenticatedRequest) {
    return this.booking.request(FOLIO_MESSAGES.REOPEN, {
      actor: this.actor(req),
      folioId: id,
      reason: dto.reason,
    });
  }

  @RequirePermissions('folio.item.void')
  @Post('folio-items/:id/void')
  voidItem(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: AuthenticatedRequest) {
    return this.booking.request(FOLIO_MESSAGES.VOID_ITEM, {
      actor: this.actor(req),
      itemId: id,
      reason: dto.reason,
    });
  }

  @RequirePermissions('folio.item.post')
  @Post('folios/:id/items')
  postCharge(@Param('id') id: string, @Body() dto: PostChargeDto, @Req() req: AuthenticatedRequest) {
    return this.booking.request(FOLIO_MESSAGES.POST_CHARGE, {
      folioId: id,
      input: {
        type: dto.type,
        description: dto.description,
        quantity: Number(dto.quantity),
        unitAmount: dto.unitAmount,
        postedById: req.user!.id,
        idempotencyKey: dto.idempotencyKey ?? null,
      },
    });
  }

  // ----------------------------------------------------------------- payments

  @RequirePermissions('payment.read')
  @Get('payments')
  payments(@Req() req: AuthenticatedRequest) {
    return this.booking.request(INVOICE_MESSAGES.PAYMENT_LEDGER, {
      propertyId: req.user!.activePropertyId,
    });
  }

  @RequirePermissions('payment.record')
  @Post('folios/:id/payments')
  recordPayment(@Param('id') id: string, @Body() dto: PaymentDto, @Req() req: AuthenticatedRequest) {
    return this.booking.request(FOLIO_MESSAGES.RECORD_PAYMENT, {
      folioId: id,
      input: {
        amount: dto.amount,
        method: dto.method,
        reference: dto.reference ?? null,
        receivedById: req.user!.id,
        idempotencyKey: dto.idempotencyKey ?? null,
      },
    });
  }

  @RequirePermissions('payment.refund')
  @Post('payments/:id/refund')
  refund(@Param('id') id: string, @Body() dto: RefundDto, @Req() req: AuthenticatedRequest) {
    return this.booking.request(FOLIO_MESSAGES.REFUND, {
      actor: this.actor(req),
      paymentId: id,
      amount: dto.amount,
      reason: dto.reason,
    });
  }

  // ----------------------------------------------------------------- invoices

  @RequirePermissions('invoice.read')
  @Get('invoices')
  invoices(@Req() req: AuthenticatedRequest) {
    return this.booking.request(INVOICE_MESSAGES.LIST, {
      propertyId: req.user!.activePropertyId,
    });
  }

  @RequirePermissions('invoice.read')
  @Get('invoices/:id')
  invoice(@Param('id') id: string) {
    return this.booking.request(INVOICE_MESSAGES.PREVIEW, { invoiceId: id });
  }

  @RequirePermissions('invoice.issue')
  @Post('folios/:id/invoices')
  issueInvoice(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.booking.request(INVOICE_MESSAGES.ISSUE, { actor: this.actor(req), folioId: id });
  }

  @RequirePermissions('invoice.void')
  @Post('invoices/:id/void')
  voidInvoice(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: AuthenticatedRequest) {
    return this.booking.request(INVOICE_MESSAGES.VOID, {
      actor: this.actor(req),
      invoiceId: id,
      reason: dto.reason,
    });
  }
}
