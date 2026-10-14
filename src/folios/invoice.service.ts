import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { db } from '../prisma/db.js';
import { brand, now } from '../prisma/compat.js';
import { fromDecimal, toDecimal } from '../common/money.js';
import { AuditService } from '../audit/audit.service.js';
import { FolioService } from './folio.service.js';

/**
 * Invoices are a presentation of a settled folio, not a parallel set of books.
 *
 * The kit's schema gives Invoice only subtotal/tax/total and no line table, so
 * the line detail for the rendered document is read back from the folio. That is
 * only safe while the folio is frozen, which is why generation is restricted to
 * CLOSED folios: an open folio could still accrue a charge after the document
 * was handed over, and the two would quietly disagree.
 */
@Injectable()
export class InvoiceService {
  constructor(
    private readonly folios: FolioService,
    private readonly audit: AuditService,
  ) {}

  private newInvoiceNo(): string {
    const d = new Date();
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    return `INV-${stamp}-${String(randomInt(0, 100_000)).padStart(5, '0')}`;
  }

  /** Invoices for a property, newest first. */
  async list(propertyId: string) {
    const invoices = await db.orm.public.Invoice
      .where({ propertyId: brand(propertyId) })
      .all();

    const folioIds = [...new Set(invoices.map((i) => i.folioId))];
    const folios = folioIds.length
      ? await db.orm.public.Folio.where((m) => m.id.in(folioIds)).all()
      : [];
    const folioById = new Map(folios.map((f) => [f.id, f]));

    const reservationIds = [...new Set(folios.map((f) => f.reservationId))];
    const reservations = reservationIds.length
      ? await db.orm.public.Reservation.where((m) => m.id.in(reservationIds)).all()
      : [];
    const resById = new Map(reservations.map((r) => [r.id, r]));

    const guestIds = [...new Set(reservations.map((r) => r.primaryGuestId))];
    const guests = guestIds.length
      ? await db.orm.public.Guest.where((m) => m.id.in(guestIds)).all()
      : [];
    const guestById = new Map(guests.map((g) => [g.id, g]));

    return invoices
      .map((i) => {
        const folio = folioById.get(i.folioId);
        const reservation = folio ? resById.get(folio.reservationId) : undefined;
        const guest = reservation ? guestById.get(reservation.primaryGuestId) : undefined;
        return {
          id: i.id,
          invoiceNo: i.invoiceNo,
          status: i.status,
          currencyCode: i.currencyCode,
          subtotal: String(i.subtotal),
          taxTotal: String(i.taxTotal),
          totalAmount: String(i.totalAmount),
          issuedAt: i.issuedAt,
          voidedAt: i.voidedAt,
          voidReason: i.voidReason,
          folioId: i.folioId,
          folioNo: folio?.folioNo ?? null,
          bookingCode: reservation?.bookingCode ?? null,
          guestName: guest ? `${guest.firstName} ${guest.lastName}` : null,
        };
      })
      .sort((a, b) => String(b.invoiceNo).localeCompare(String(a.invoiceNo)));
  }

  /**
   * Issues an invoice against a closed folio.
   *
   * The totals are taken from the folio balance rather than recomputed, so the
   * document states the same figures the guest settled.
   */
  async issue(req: any, folioId: string) {
    const folio = await db.orm.public.Folio.where({ id: brand(folioId) }).first();
    if (!folio) throw new NotFoundException('Folio not found');

    if (folio.status !== 'CLOSED') {
      throw new ConflictException(
        'An invoice can only be issued against a closed folio. Close the folio first.',
      );
    }

    const existing = await db.orm.public.Invoice
      .where({ folioId: brand(folioId), status: brand('ISSUED') })
      .first();
    if (existing) {
      return { idempotent: true, id: existing.id, invoiceNo: existing.invoiceNo };
    }

    const balance = await this.folios.balance(folioId);
    if (fromDecimal(balance.total).minor === 0) {
      throw new ConflictException('Nothing to invoice: the folio total is zero');
    }

    const propertyId = folio.propertyId;
    let invoice: any = null;

    // `invoiceNo` is unique per property, so a collision under concurrency is
    // retried rather than surfaced as a 500.
    for (let attempt = 0; attempt < 5 && !invoice; attempt++) {
      try {
        invoice = await db.orm.public.Invoice.create({
          propertyId: brand(propertyId),
          folioId: brand(folioId),
          invoiceNo: brand(this.newInvoiceNo()),
          status: brand('ISSUED'),
          currencyCode: brand(folio.currencyCode),
          subtotal: brand(balance.charges),
          taxTotal: brand(balance.tax),
          totalAmount: brand(balance.total),
          issuedAt: now(),
        });
      } catch (e) {
        const msg = String((e as { message?: string })?.message ?? '');
        if (msg.includes('Invoice_propertyId_invoiceNo_key') || /duplicate key/i.test(msg)) {
          continue;
        }
        throw e;
      }
    }
    if (!invoice) {
      throw new ConflictException('Could not allocate an invoice number; please retry');
    }

    await this.audit.record({
      organizationId: req.user?.organizationId,
      propertyId,
      actorUserId: req.user?.id,
      action: 'invoice.issue',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      outcome: 'SUCCESS',
      metadata: {
        invoiceNo: invoice.invoiceNo,
        folioId,
        subtotal: balance.charges,
        taxTotal: balance.tax,
        total: balance.total,
      },
    });

    return {
      idempotent: false,
      id: invoice.id,
      invoiceNo: invoice.invoiceNo,
      status: 'ISSUED',
      subtotal: balance.charges,
      taxTotal: balance.tax,
      totalAmount: balance.total,
      currencyCode: invoice.currencyCode,
    };
  }

  /** Full document: header, property, guest, and the folio's charge lines. */
  async preview(invoiceId: string) {
    const invoice = await db.orm.public.Invoice.where({ id: brand(invoiceId) }).first();
    if (!invoice) throw new NotFoundException('Invoice not found');

    const [folio, property] = await Promise.all([
      db.orm.public.Folio.where({ id: brand(invoice.folioId) }).first(),
      db.orm.public.Property.where({ id: brand(invoice.propertyId) }).first(),
    ]);
    const reservation = folio
      ? await db.orm.public.Reservation.where({ id: brand(folio.reservationId) }).first()
      : null;
    const guest = reservation
      ? await db.orm.public.Guest.where({ id: brand(reservation.primaryGuestId) }).first()
      : null;

    const items = await db.orm.public.FolioItem
      .where({ folioId: brand(invoice.folioId) })
      .all();

    return {
      id: invoice.id,
      invoiceNo: invoice.invoiceNo,
      status: invoice.status,
      currencyCode: invoice.currencyCode,
      issuedAt: invoice.issuedAt,
      voidedAt: invoice.voidedAt,
      voidReason: invoice.voidReason,
      folioId: invoice.folioId,
      folioNo: folio?.folioNo ?? null,
      bookingCode: reservation?.bookingCode ?? null,
      property: property
        ? {
            name: property.name,
            addressLine1: property.addressLine1,
            city: property.city,
            countryCode: property.countryCode,
          }
        : null,
      guestName: guest ? `${guest.firstName} ${guest.lastName}` : null,
      subtotal: String(invoice.subtotal),
      taxTotal: String(invoice.taxTotal),
      totalAmount: String(invoice.totalAmount),
      lines: items
        // Voided lines are excluded along with their paired reversals, matching
        // how the balance treats them.
        .filter((i) => !i.isVoided && i.type !== 'REVERSAL')
        .map((i) => ({
          id: i.id,
          createdAt: i.createdAt,
          description: i.description,
          quantity: String(i.quantity),
          unitAmount: String(i.unitAmount),
          taxAmount: String(i.taxAmount ?? 0),
          totalAmount: String(i.totalAmount),
          type: i.type,
        })),
    };
  }

  /** Withdraws an issued invoice. Reason is mandatory. */
  async voidInvoice(req: any, invoiceId: string, reason: string) {
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('Voiding an invoice requires a reason');

    const invoice = await db.orm.public.Invoice.where({ id: brand(invoiceId) }).first();
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status === 'VOID') {
      return { idempotent: true, id: invoice.id, status: 'VOID' };
    }
    if (invoice.status !== 'ISSUED') {
      throw new ConflictException(`A ${invoice.status} invoice cannot be voided`);
    }

    await db.transaction(async (tx: any) => {
      await tx.orm.public.Invoice.where({ id: brand(invoiceId) }).update({
        status: brand('VOID'),
        voidedAt: now(),
        voidReason: brand(trimmed),
      });
      await this.audit.record(
        {
          organizationId: req.user?.organizationId,
          propertyId: invoice.propertyId,
          actorUserId: req.user?.id,
          action: 'invoice.void',
          resourceType: 'Invoice',
          resourceId: invoice.id,
          reason: trimmed,
          outcome: 'SUCCESS',
          metadata: { invoiceNo: invoice.invoiceNo, totalAmount: String(invoice.totalAmount) },
        },
        tx,
      );
    });

    return { idempotent: false, id: invoice.id, status: 'VOID', invoiceNo: invoice.invoiceNo };
  }

  /** Property-scoped payment ledger, newest first. */
  async paymentLedger(propertyId: string) {
    const folios = await db.orm.public.Folio.where({ propertyId: brand(propertyId) }).all();
    if (folios.length === 0) return [];

    const folioById = new Map(folios.map((f) => [f.id, f]));
    const payments = await db.orm.public.Payment
      .where((m) => m.folioId.in(folios.map((f) => f.id)))
      .all();

    return payments
      .map((p) => ({
        id: p.id,
        folioId: p.folioId,
        folioNo: folioById.get(p.folioId)?.folioNo ?? null,
        amount: String(p.amount),
        currencyCode: p.currencyCode,
        method: p.method,
        status: p.status,
        reference: p.reference,
        refundedAmount: p.refundedAmount ? String(p.refundedAmount) : '0.00',
        refundedAt: p.refundedAt,
        reason: p.reason,
        recordedAt: p.recordedAt,
      }))
      .sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)));
  }
}