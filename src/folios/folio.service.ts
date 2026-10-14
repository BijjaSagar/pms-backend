import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { db } from '../prisma/db.js';
import { brand, json, now } from '../prisma/compat.js';
import { computeTotals, fromDecimal, toDecimal, type TaxRule } from '../common/money.js';
import { activeTaxRules } from '../common/tax-rules.js';
import { splitLedger } from '../common/ledger.js';
import { AuditService } from '../audit/audit.service.js';

export interface Balance {
  charges: string;
  tax: string;
  total: string;
  paid: string;
  balance: string;
  currencyCode: string;
}

@Injectable()
export class FolioService {
  constructor(private readonly audit: AuditService) {}

  /** Tax rules currently in force for a property. Shared with reservation estimates. */
  private async taxRules(propertyId: string): Promise<TaxRule[]> {
    return activeTaxRules(propertyId);
  }

  /**
   * Finds the open folio for a reservation, or creates one.
   *
   * `folioNo` is unique per property and the retry loop exists because a
   * collision is possible under concurrency even with a random suffix.
   */
  async openFolio(propertyId: string, reservationId: string, currencyCode: string) {
    const existing = await db.orm.public.Folio
      .where({ reservationId: brand(reservationId) })
      .first();
    if (existing) return existing;

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await db.orm.public.Folio.create({
          propertyId: brand(propertyId),
          reservationId: brand(reservationId),
          folioNo: brand(this.newFolioNo()),
          status: brand('OPEN'),
          currencyCode: brand(currencyCode),
          openedAt: now(),
        });
      } catch (e) {
        const msg = String((e as { message?: string })?.message ?? '');
        if (/duplicate key value violates unique constraint/i.test(msg) && msg.includes('Folio_propertyId_folioNo_key')) {
          continue;
        }
        throw e;
      }
    }
    throw new ConflictException('Could not allocate a folio number; please retry');
  }

  private newFolioNo(): string {
    const d = new Date();
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    return `F-${stamp}-${String(randomInt(0, 100_000)).padStart(5, '0')}`;
  }

  /**
   * Posts a charge line.
   *
   * `idempotencyKey` maps to the unique column of the same name, so a retried
   * request returns the existing line instead of double-charging. This is the
   * mechanism the kit asks for wherever a retry could duplicate a posting.
   */
  async postCharge(
    folioId: string,
    input: {
      type: string;
      description: string;
      quantity: number;
      unitAmount: string;
      postedById?: string | null;
      idempotencyKey?: string | null;
      taxable?: boolean;
    },
  ) {
    if (input.idempotencyKey) {
      const dupe = await db.orm.public.FolioItem
        .where({ idempotencyKey: brand(input.idempotencyKey) })
        .first();
      if (dupe) {
        // A replay is not a second charge, so it must not be written a second
        // time to the audit trail either. Returning the original row unchanged
        // is what makes a retry safe to show in a log an auditor reads.
        return { ...dupe, idempotent: true };
      }
    }

    const qty = Number(input.quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new BadRequestException('Quantity must be a positive whole number');
    }
    let unit: ReturnType<typeof fromDecimal>;
    try {
      unit = fromDecimal(input.unitAmount);
    } catch {
      throw new BadRequestException('unitAmount must be a decimal amount with up to 2 decimals');
    }
    const gross = unit.minor * qty;
    if (gross < 0 && input.type !== 'DISCOUNT' && input.type !== 'ADJUSTMENT') {
      throw new BadRequestException('Only DISCOUNT or ADJUSTMENT lines may reduce a folio');
    }
    const rules = await this.taxRules(
      (await db.orm.public.Folio.where({ id: brand(folioId) }).first())?.propertyId ?? '',
    );
    const totals = computeTotals(
      [{ amount: { minor: gross }, taxable: input.taxable ?? true }],
      rules,
    );

    const item = await db.orm.public.FolioItem.create({
      folioId: brand(folioId),
      type: brand(input.type) as never,
      description: brand(input.description),
      quantity: brand(String(qty)),
      unitAmount: brand(input.unitAmount),
      taxAmount: brand(toDecimal(totals.taxTotal)),
      taxSnapshot: json(rules.length ? rules : null),
      totalAmount: brand(toDecimal({ minor: gross })),
      postedById: brand(input.postedById ?? null),
      idempotencyKey: brand(input.idempotencyKey ?? null),
      isVoided: brand(false),
    });

    // An auditor has to be able to answer "who added this line and when". The
    // postedById column answers the first half but is invisible from the audit
    // log, and nothing else recorded the event at all — which left the trail
    // unable to reconstruct a folio, exactly what Section 14 requires.
    const scope = await this.scopeOf(folioId);
    await this.audit.record({
      organizationId: scope.organizationId,
      propertyId: scope.propertyId,
      actorUserId: input.postedById ?? null,
      action: 'folio.item.post',
      resourceType: 'FolioItem',
      resourceId: item.id,
      outcome: 'SUCCESS',
      metadata: {
        folioId,
        type: input.type,
        description: input.description,
        quantity: String(qty),
        unitAmount: input.unitAmount,
        total: toDecimal({ minor: gross }),
        tax: toDecimal(totals.taxTotal),
      },
    });

    return item;
  }

  /**
   * Audit scope for a folio.
   *
   * Posting is reachable both from a request and from inside another service
   * (check-in posts the first night, checkout posts the top-up), so the request
   * context is not always available and the property has to be resolved from the
   * folio itself.
   */
  private async scopeOf(folioId: string): Promise<{ propertyId: string; organizationId: string }> {
    const folio = await db.orm.public.Folio.where({ id: brand(folioId) }).first();
    if (!folio) return { propertyId: '', organizationId: '' };
    const property = await db.orm.public.Property
      .where({ id: brand(folio.propertyId) })
      .first();
    return {
      propertyId: folio.propertyId,
      organizationId: property?.organizationId ?? '',
    };
  }

  /**
   * Computes the folio balance from the amounts recorded on each line.
   *
   * Tax is read from each item's stored `taxAmount`, not recomputed from the
   * current `TaxRule` rows. Recomputing would mean a later edit to a tax rule
   * silently rewrote what every folio already in progress says a guest owes —
   * a guest's bill changing after the fact because someone updated a rate.
   * `postCharge` already resolved tax at posting time and snapshotted the rules
   * onto the line, so the stored figure is the authoritative one.
   *
   * Reading the stored value also does the right thing for lines the previous
   * recomputation taxed wrongly: DISCOUNT and ADJUSTMENT lines carry whatever
   * tax was calculated when they were posted, which is zero, rather than being
   * taxed afresh as if they were new charges.
   *
   * Voided lines are excluded entirely rather than being netted, so a voided
   * charge leaves no trace in the money while remaining visible in the ledger.
   */
  async balance(folioId: string): Promise<Balance> {
    const folio = await db.orm.public.Folio.where({ id: brand(folioId) }).first();
    if (!folio) throw new NotFoundException('Folio not found');

    const items = await db.orm.public.FolioItem.where({ folioId: brand(folioId) }).all();
    const live = items.filter((i) => !i.isVoided);

    // TAX-typed lines hold tax and no charge of their own; every other line
    // holds a charge plus its own tax. Summing both columns across the live
    // lines keeps the printed folio internally consistent.
    const { chargesMinor, taxMinor } = splitLedger(live);
    const totalMinor = chargesMinor + taxMinor;

    const payments = await db.orm.public.Payment.where({ folioId: brand(folioId) }).all();
    // Only PENDING and FAILED are excluded: those never collected. A refunded
    // payment DID collect, and subtracting the refunded portion is what leaves
    // the correct remainder. Filtering on SUCCEEDED alone would discard a
    // partially refunded payment in full and inflate the balance owed.
    const paidMinor = payments.reduce((acc, p) => {
      if (p.status === 'PENDING' || p.status === 'FAILED') return acc;
      const amount = fromDecimal(String(p.amount)).minor;
      const refunded = p.refundedAmount ? fromDecimal(String(p.refundedAmount)).minor : 0;
      return acc + amount - refunded;
    }, 0);

    return {
      charges: toDecimal({ minor: chargesMinor }),
      tax: toDecimal({ minor: taxMinor }),
      total: toDecimal({ minor: totalMinor }),
      paid: toDecimal({ minor: paidMinor }),
      balance: toDecimal({ minor: totalMinor - paidMinor }),
      currencyCode: folio.currencyCode,
    };
  }

  /** Records a settled payment. Never stores card data. */
  async recordPayment(
    folioId: string,
    input: {
      amount: string;
      method: string;
      reference?: string | null;
      receivedById?: string | null;
      idempotencyKey?: string | null;
    },
  ) {
    if (input.idempotencyKey) {
      const dupe = await db.orm.public.Payment
        .where({ idempotencyKey: brand(input.idempotencyKey) })
        .first();
      // As with charges, a replay is the same payment, not a second one, and
      // must not appear twice in a ledger an auditor reconciles by hand.
      if (dupe) return { ...dupe, idempotent: true };
    }
    const folio = await db.orm.public.Folio.where({ id: brand(folioId) }).first();
    if (!folio) throw new NotFoundException('Folio not found');
    if (folio.status !== 'OPEN') {
      throw new ConflictException('Cannot post a payment to a closed folio');
    }

    let tendered: ReturnType<typeof fromDecimal>;
    try {
      tendered = fromDecimal(input.amount);
    } catch {
      throw new BadRequestException('amount must be a decimal amount with up to 2 decimals');
    }
    if (tendered.minor <= 0) throw new BadRequestException('Payment amount must be positive');

    const payment = await db.orm.public.Payment.create({
      folioId: brand(folioId),
      amount: brand(input.amount),
      currencyCode: brand(folio.currencyCode),
      method: brand(input.method) as never,
      status: brand('SUCCEEDED'),
      reference: brand(input.reference ?? null),
      receivedById: brand(input.receivedById ?? null),
      idempotencyKey: brand(input.idempotencyKey ?? null),
      recordedAt: now(),
      settledAt: now(),
    });

    // Money received is the event an auditor most often has to reconstruct
    // after the fact. Without this row the only record is the Payment row
    // itself, which carries no actor and sits outside the audit trail.
    const scope = await this.scopeOf(folioId);
    await this.audit.record({
      organizationId: scope.organizationId,
      propertyId: scope.propertyId,
      actorUserId: input.receivedById ?? null,
      action: 'payment.record',
      resourceType: 'Payment',
      resourceId: payment.id,
      outcome: 'SUCCESS',
      // Deliberately no card or bank details: method and amount are what a
      // reconciliation needs, and anything more is not ours to keep.
      metadata: {
        folioId,
        amount: input.amount,
        currencyCode: folio.currencyCode,
        method: input.method,
        reference: input.reference ?? null,
      },
    });

    return payment;
  }

  // ------------------------------------------------------------ detail & void

  /** Folio with its full ledger: items, payments and any invoices raised. */
  async detail(folioId: string) {
    const folio = await db.orm.public.Folio.where({ id: brand(folioId) }).first();
    if (!folio) throw new NotFoundException('Folio not found');

    const [items, payments, invoices, reservation] = await Promise.all([
      db.orm.public.FolioItem.where({ folioId: brand(folioId) }).all(),
      db.orm.public.Payment.where({ folioId: brand(folioId) }).all(),
      db.orm.public.Invoice.where({ folioId: brand(folioId) }).all(),
      db.orm.public.Reservation.where({ id: brand(folio.reservationId) }).first(),
    ]);

    const guest = await db.orm.public.Guest
      .where({ id: brand(reservation?.primaryGuestId ?? '') })
      .first();

    const balance = await this.balance(folioId);

    return {
      id: folio.id,
      folioNo: folio.folioNo,
      status: folio.status,
      currencyCode: folio.currencyCode,
      openedAt: folio.openedAt,
      closedAt: folio.closedAt,
      reservationId: folio.reservationId,
      bookingCode: reservation?.bookingCode ?? null,
      guestName: guest ? `${guest.firstName} ${guest.lastName}` : null,
      balance,
      items: items.map((i) => ({
        id: i.id,
        type: i.type,
        description: i.description,
        quantity: String(i.quantity),
        unitAmount: String(i.unitAmount),
        taxAmount: String(i.taxAmount ?? 0),
        totalAmount: String(i.totalAmount),
        isVoided: i.isVoided,
        voidedAt: i.voidedAt,
        reason: i.reason,
        createdAt: i.createdAt,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        amount: String(p.amount),
        currencyCode: p.currencyCode,
        method: p.method,
        status: p.status,
        reference: p.reference,
        refundedAmount: p.refundedAmount ? String(p.refundedAmount) : '0.00',
        refundedAt: p.refundedAt,
        reason: p.reason,
        recordedAt: p.recordedAt,
      })),
      invoices: invoices.map((v) => ({
        id: v.id,
        invoiceNo: v.invoiceNo,
        status: v.status,
        subtotal: String(v.subtotal),
        taxTotal: String(v.taxTotal),
        totalAmount: String(v.totalAmount),
        issuedAt: v.issuedAt,
        voidedAt: v.voidedAt,
        voidReason: v.voidReason,
      })),
    };
  }

  /**
   * Voids a posted charge.
   *
   * The original row is flagged rather than deleted, and a linked REVERSAL line
   * is written so the ledger shows the correction as a movement of money. Both
   * are excluded from the balance: flagging prevents the original counting, and
   * the reversal exists for the audit trail, not as a second deduction.
   */
  async voidItem(
    req: any,
    itemId: string,
    reason: string,
  ) {
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('A void requires a reason');

    const item = await db.orm.public.FolioItem.where({ id: brand(itemId) }).first();
    if (!item) throw new NotFoundException('Folio item not found');

    const folio = await db.orm.public.Folio.where({ id: brand(item.folioId) }).first();
    if (!folio) throw new NotFoundException('Folio not found');
    if (folio.status !== 'OPEN') {
      throw new ConflictException('Reopen the folio before voiding a charge');
    }
    if (item.isVoided) {
      // Idempotent: a repeated void reports the existing state rather than
      // posting a second reversal.
      return { idempotent: true, itemId, status: 'VOIDED' };
    }

    const propertyId = folio.propertyId;

    return db.transaction(async (tx: any) => {
      await tx.orm.public.FolioItem.where({ id: brand(item.id) }).update({
        isVoided: brand(true),
        voidedAt: now(),
        reason: brand(trimmed),
      });

      await tx.orm.public.FolioItem.create({
        folioId: brand(folio.id),
        type: brand('REVERSAL') as never,
        description: brand(`Reversal of: ${item.description}`),
        quantity: brand('1'),
        unitAmount: brand(String(item.totalAmount)),
        taxAmount: brand(String(item.taxAmount ?? 0)),
        // Flagged as voided so the pair nets to nothing. The reversal is a
        // record of what happened, not a second charge.
        totalAmount: brand(String(item.totalAmount)),
        postedById: brand(req.user?.id ?? null),
        reason: brand(trimmed),
        isVoided: brand(true),
      });

      await this.audit.record(
        {
          organizationId: req.user?.organizationId,
          propertyId,
          actorUserId: req.user?.id,
          action: 'folio.item.void',
          resourceType: 'FolioItem',
          resourceId: item.id,
          reason: trimmed,
          outcome: 'SUCCESS',
          metadata: {
            folioId: folio.id,
            amount: String(item.totalAmount),
            taxAmount: String(item.taxAmount ?? 0),
          },
        },
        tx,
      );

      return { idempotent: false, itemId: item.id, status: 'VOIDED', folioId: folio.id };
    });
  }

  // ----------------------------------------------------------- close & reopen

  async close(req: any, folioId: string) {
    const folio = await db.orm.public.Folio.where({ id: brand(folioId) }).first();
    if (!folio) throw new NotFoundException('Folio not found');
    if (folio.status === 'CLOSED') {
      return { idempotent: true, status: 'CLOSED', closedAt: folio.closedAt };
    }
    if (folio.status !== 'OPEN') {
      throw new ConflictException(`A ${folio.status} folio cannot be closed`);
    }

    const balance = await this.balance(folioId);

    return db.transaction(async (tx: any) => {
      await tx.orm.public.Folio.where({ id: brand(folioId) }).update({
        status: brand('CLOSED'),
        closedAt: now(),
      });
      await this.audit.record(
        {
          organizationId: req.user?.organizationId,
          propertyId: folio.propertyId,
          actorUserId: req.user?.id,
          action: 'folio.close',
          resourceType: 'Folio',
          resourceId: folio.id,
          outcome: 'SUCCESS',
          metadata: { total: balance.total, balance: balance.balance },
        },
        tx,
      );
      return { idempotent: false, status: 'CLOSED', folioId, balance };
    });
  }

  /**
   * Reopens a closed folio.
   *
   * Refused while an issued invoice exists. An invoice is a document the guest
   * may already hold; reopening the folio would let the two drift apart, and the
   * invoice is the artefact that must be withdrawn first.
   */
  async reopen(req: any, folioId: string, reason: string) {
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('A reopen requires a reason');

    const folio = await db.orm.public.Folio.where({ id: brand(folioId) }).first();
    if (!folio) throw new NotFoundException('Folio not found');
    if (folio.status === 'OPEN') {
      return { idempotent: true, status: 'OPEN', folioId };
    }
    if (folio.status !== 'CLOSED') {
      throw new ConflictException(`A ${folio.status} folio cannot be reopened`);
    }

    const issued = await db.orm.public.Invoice
      .where({ folioId: brand(folioId), status: brand('ISSUED') })
      .first();
    if (issued) {
      throw new ConflictException(
        `Invoice ${issued.invoiceNo} has been issued against this folio. Void the invoice before reopening.`,
      );
    }

    return db.transaction(async (tx: any) => {
      await tx.orm.public.Folio.where({ id: brand(folioId) }).update({
        status: brand('OPEN'),
        closedAt: brand(null),
      });
      await this.audit.record(
        {
          organizationId: req.user?.organizationId,
          propertyId: folio.propertyId,
          actorUserId: req.user?.id,
          action: 'folio.reopen',
          resourceType: 'Folio',
          resourceId: folio.id,
          reason: trimmed,
          outcome: 'SUCCESS',
          metadata: {},
        },
        tx,
      );
      return { idempotent: false, status: 'OPEN', folioId };
    });
  }

  // ------------------------------------------------------------------ refund

  /**
   * Refunds all or part of a payment.
   *
   * The running total is kept on the payment itself so "has this been refunded
   * already" is one column read rather than a sum over child rows, and so a
   * second refund cannot exceed what is left.
   */
  async refund(req: any, paymentId: string, amount: string, reason: string) {
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('A refund requires a reason');

    const payment = await db.orm.public.Payment.where({ id: brand(paymentId) }).first();
    if (!payment) throw new NotFoundException('Payment not found');
    // PARTIALLY_REFUNDED is refundable: that is what it means. Refusing it would
    // make a partial refund a one-shot operation, stranding whatever is left.
    if (payment.status !== 'SUCCEEDED' && payment.status !== 'PARTIALLY_REFUNDED') {
      throw new ConflictException(`A ${payment.status} payment cannot be refunded`);
    }

    const original = fromDecimal(String(payment.amount)).minor;
    const alreadyRefunded = payment.refundedAmount
      ? fromDecimal(String(payment.refundedAmount)).minor
      : 0;
    const refundable = original - alreadyRefunded;
    if (refundable <= 0) {
      throw new ConflictException('This payment has already been fully refunded');
    }

    let requested: number;
    try {
      requested = fromDecimal(amount).minor;
    } catch {
      throw new BadRequestException('Refund amount must be a decimal amount with up to 2 decimals');
    }
    if (requested <= 0) throw new BadRequestException('Refund amount must be positive');
    if (requested > refundable) {
      throw new ConflictException(
        `Refund of ${toDecimal({ minor: requested })} exceeds the refundable balance of ${toDecimal({ minor: refundable })} ${payment.currencyCode}`,
      );
    }

    const newRefunded = alreadyRefunded + requested;
    const fullyRefunded = newRefunded >= original;
    const folio = await db.orm.public.Folio.where({ id: brand(payment.folioId) }).first();

    return db.transaction(async (tx: any) => {
      await tx.orm.public.Payment.where({ id: brand(payment.id) }).update({
        refundedAmount: brand(toDecimal({ minor: newRefunded })),
        refundedAt: now(),
        reason: brand(trimmed),
        status: brand(fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED'),
      });

      await this.audit.record(
        {
          organizationId: req.user?.organizationId,
          propertyId: folio?.propertyId,
          actorUserId: req.user?.id,
          action: 'payment.refund',
          resourceType: 'Payment',
          resourceId: payment.id,
          reason: trimmed,
          outcome: 'SUCCESS',
          metadata: {
            amount: toDecimal({ minor: requested }),
            refundedTotal: toDecimal({ minor: newRefunded }),
            original: String(payment.amount),
            fullyRefunded,
          },
        },
        tx,
      );

      return {
        id: payment.id,
        status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        amount: toDecimal({ minor: requested }),
        refundedAmount: toDecimal({ minor: newRefunded }),
        refundableRemaining: toDecimal({ minor: refundable - requested }),
      };
    });
  }

  /** Refuses an operation the caller lacks the permission for. */
  requirePermission(req: any, permission: string, what: string): void {
    if (!(req.user?.permissions ?? []).includes(permission)) {
      throw new ForbiddenException(`You do not have permission to ${what}.`);
    }
  }
}