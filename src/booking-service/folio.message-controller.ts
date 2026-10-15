import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { toRpcException } from '../common/rpc-to-http.js';
import type { ActorContext } from '../contracts/shared.js';
import {
  FOLIO_MESSAGES,
  INVOICE_MESSAGES,
  type PostChargeInput,
  type RecordPaymentInput,
} from '../contracts/booking.messages.js';
import { FolioService } from './folio.service.js';
import { InvoiceService } from './invoice.service.js';

/** Folio ledger, payments, refunds and invoices. */
@Controller()
export class FolioMessageController {
  constructor(
    private readonly folios: FolioService,
    private readonly invoices: InvoiceService,
  ) {}

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toRpcException(error);
    }
  }

  @MessagePattern(FOLIO_MESSAGES.BALANCE)
  balance(@Payload() d: { folioId: string }) {
    return this.run(() => this.folios.balance(d.folioId));
  }

  @MessagePattern(FOLIO_MESSAGES.DETAIL)
  detail(@Payload() d: { folioId: string }) {
    return this.run(() => this.folios.detail(d.folioId));
  }

  @MessagePattern(FOLIO_MESSAGES.CLOSE)
  close(@Payload() d: { actor: ActorContext; folioId: string }) {
    return this.run(() => this.folios.close(d.actor, d.folioId));
  }

  @MessagePattern(FOLIO_MESSAGES.REOPEN)
  reopen(@Payload() d: { actor: ActorContext; folioId: string; reason: string }) {
    return this.run(() => this.folios.reopen(d.actor, d.folioId, d.reason));
  }

  @MessagePattern(FOLIO_MESSAGES.VOID_ITEM)
  voidItem(@Payload() d: { actor: ActorContext; itemId: string; reason: string }) {
    return this.run(() => this.folios.voidItem(d.actor, d.itemId, d.reason));
  }

  @MessagePattern(FOLIO_MESSAGES.POST_CHARGE)
  postCharge(@Payload() d: { folioId: string; input: PostChargeInput }) {
    return this.run(() => this.folios.postCharge(d.folioId, d.input));
  }

  @MessagePattern(FOLIO_MESSAGES.RECORD_PAYMENT)
  recordPayment(@Payload() d: { folioId: string; input: RecordPaymentInput }) {
    return this.run(() => this.folios.recordPayment(d.folioId, d.input));
  }

  @MessagePattern(FOLIO_MESSAGES.REFUND)
  refund(@Payload() d: { actor: ActorContext; paymentId: string; amount: string; reason: string }) {
    return this.run(() => this.folios.refund(d.actor, d.paymentId, d.amount, d.reason));
  }

  // ---------------------------------------------------------------- invoices

  @MessagePattern(INVOICE_MESSAGES.LIST)
  invoiceList(@Payload() d: { propertyId: string }) {
    return this.run(() => this.invoices.list(d.propertyId));
  }

  @MessagePattern(INVOICE_MESSAGES.PREVIEW)
  invoicePreview(@Payload() d: { invoiceId: string }) {
    return this.run(() => this.invoices.preview(d.invoiceId));
  }

  @MessagePattern(INVOICE_MESSAGES.ISSUE)
  invoiceIssue(@Payload() d: { actor: ActorContext; folioId: string }) {
    return this.run(() => this.invoices.issue(d.actor, d.folioId));
  }

  @MessagePattern(INVOICE_MESSAGES.VOID)
  invoiceVoid(@Payload() d: { actor: ActorContext; invoiceId: string; reason: string }) {
    return this.run(() => this.invoices.voidInvoice(d.actor, d.invoiceId, d.reason));
  }

  @MessagePattern(INVOICE_MESSAGES.PAYMENT_LEDGER)
  paymentLedger(@Payload() d: { propertyId: string }) {
    return this.run(() => this.invoices.paymentLedger(d.propertyId));
  }
}
