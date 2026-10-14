/**
 * Deterministic demo data so a new checkout has life in it.
 *
 * Covers every screen: guests, past / current / upcoming stays, folios with
 * real money, payments, invoices, housekeeping, maintenance, night audits,
 * notifications, theme prefs and audit rows.
 *
 * Run: npm run db:seed:demo   (requires db:seed + db:dev-users first)
 * Full: npm run db:reseed
 *
 * Deterministic: same PRNG seed every run, fixed DEMO- codes, dates anchored
 * to the property business date (Asia/Kolkata). Re-running clears previous
 * demo transactional rows first, so it is idempotent.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { addDays, businessDateFor, enumerateNights } from '../src/common/dates.js';
import { applyPercent, fromDecimal, toDecimal } from '../src/common/money.js';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

// Deterministic PRNG so every reseed produces the same demo world.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = [
  'Aarav', 'Ananya', 'Arjun', 'Diya', 'Ishaan', 'Kavya', 'Krishna', 'Meera',
  'Nikhil', 'Priya', 'Rahul', 'Riya', 'Rohan', 'Sanya', 'Vikram', 'Zara',
  'Aditya', 'Elena', 'Farhan', 'Gauri', 'Harsh', 'Ira', 'James', 'Karan',
  'Lakshmi', 'Manoj', 'Neha', 'Olivia', 'Pooja', 'Rajesh', 'Sofia', 'Tara',
  'Uday', 'Varun', 'William', 'Yuki', 'Zaid', 'Aisha', 'Dev', 'Emma',
];
const LAST = [
  'Sharma', 'Patel', 'Reddy', 'Iyer', 'Khan', 'Gupta', 'Nair', 'Singh',
  'Mehta', 'Joshi', 'Chopra', 'Rao', 'Verma', 'Kapoor', 'Das', 'Kulkarni',
  'Fernandez', 'Okafor', 'Tanaka', 'Smith', 'Garcia', 'Muller', 'Chen', 'Ali',
  'Bose', 'Chauhan', 'Dubey', 'Eswaran', 'Fotedar', 'Gill', 'Hegde', 'Jain',
  'Kaul', 'Lal', 'Menon', 'Nanda', 'Oberoi', 'Pillai', 'Qureshi', 'Rana',
];
const COMPANIES = [
  'Infosys Ltd', 'Tata Consultancy', 'HDFC Bank', 'Reliance Industries',
  'Wipro', 'GO-MMT Travel', 'Acme Corp', 'Globex Events', null, null,
];
const SOURCES = ['DIRECT', 'OTA', 'CORPORATE', 'WALK_IN', 'PHONE', 'EMAIL'] as const;
const METHODS = ['CASH', 'UPI', 'CARD_TERMINAL', 'BANK_TRANSFER'] as const;
const INCIDENTALS: Array<{ desc: string; amount: string }> = [
  { desc: 'Restaurant — dinner', amount: '1450.00' },
  { desc: 'Mini bar', amount: '650.00' },
  { desc: 'Laundry — 4 pcs', amount: '800.00' },
  { desc: 'Airport transfer', amount: '1800.00' },
  { desc: 'Spa — 60 min', amount: '2200.00' },
  { desc: 'Room service — breakfast', amount: '950.00' },
];

interface Spec {
  key: string;
  inOff: number;
  outOff: number;
  status: string;
  source: string;
  adults: number;
  children: number;
  typeIdx: number;
  note?: string;
}

// 35 stays: 10 past, 8 current, 12 upcoming (4 arriving today), 3 cancelled, 2 no-show.
const SPECS: Spec[] = [
  { key: 'P1', inOff: -12, outOff: -10, status: 'CHECKED_OUT', source: 'DIRECT', adults: 2, children: 0, typeIdx: 0 },
  { key: 'P2', inOff: -11, outOff: -9, status: 'CHECKED_OUT', source: 'OTA', adults: 2, children: 1, typeIdx: 1 },
  { key: 'P3', inOff: -10, outOff: -7, status: 'CHECKED_OUT', source: 'CORPORATE', adults: 2, children: 2, typeIdx: 2, note: 'High floor, early check-in if possible' },
  { key: 'P4', inOff: -9, outOff: -8, status: 'CHECKED_OUT', source: 'DIRECT', adults: 2, children: 0, typeIdx: 3 },
  { key: 'P5', inOff: -8, outOff: -6, status: 'CHECKED_OUT', source: 'OTA', adults: 2, children: 0, typeIdx: 4, note: 'Anniversary — quiet room' },
  { key: 'P6', inOff: -7, outOff: -5, status: 'CHECKED_OUT', source: 'PHONE', adults: 1, children: 0, typeIdx: 0 },
  { key: 'P7', inOff: -6, outOff: -4, status: 'CHECKED_OUT', source: 'EMAIL', adults: 2, children: 0, typeIdx: 1 },
  { key: 'P8', inOff: -5, outOff: -3, status: 'CHECKED_OUT', source: 'DIRECT', adults: 2, children: 2, typeIdx: 2 },
  { key: 'P9', inOff: -4, outOff: -2, status: 'CHECKED_OUT', source: 'CORPORATE', adults: 1, children: 0, typeIdx: 3 },
  { key: 'P10', inOff: -3, outOff: -1, status: 'CHECKED_OUT', source: 'WALK_IN', adults: 2, children: 0, typeIdx: 4 },
  { key: 'C1', inOff: -2, outOff: 0, status: 'CHECKED_IN', source: 'DIRECT', adults: 2, children: 0, typeIdx: 0 },
  { key: 'C2', inOff: -1, outOff: 0, status: 'CHECKED_IN', source: 'OTA', adults: 2, children: 1, typeIdx: 1 },
  { key: 'C3', inOff: -3, outOff: 0, status: 'CHECKED_IN', source: 'CORPORATE', adults: 2, children: 0, typeIdx: 2, note: 'Long stay, needs desk' },
  { key: 'C4', inOff: -2, outOff: 1, status: 'CHECKED_IN', source: 'DIRECT', adults: 2, children: 0, typeIdx: 3 },
  { key: 'C5', inOff: -1, outOff: 1, status: 'CHECKED_IN', source: 'PHONE', adults: 2, children: 0, typeIdx: 4 },
  { key: 'C6', inOff: -1, outOff: 2, status: 'CHECKED_IN', source: 'DIRECT', adults: 1, children: 0, typeIdx: 0 },
  { key: 'C7', inOff: 0, outOff: 2, status: 'CHECKED_IN', source: 'WALK_IN', adults: 2, children: 0, typeIdx: 1 },
  { key: 'C8', inOff: 0, outOff: 1, status: 'CHECKED_IN', source: 'DIRECT', adults: 2, children: 2, typeIdx: 2 },
  { key: 'U1', inOff: 0, outOff: 2, status: 'CONFIRMED', source: 'OTA', adults: 2, children: 0, typeIdx: 3 },
  { key: 'U2', inOff: 0, outOff: 1, status: 'CONFIRMED', source: 'DIRECT', adults: 2, children: 0, typeIdx: 4, note: 'Late arrival ~11pm' },
  { key: 'U3', inOff: 0, outOff: 3, status: 'CONFIRMED', source: 'CORPORATE', adults: 1, children: 0, typeIdx: 0 },
  { key: 'U4', inOff: 0, outOff: 2, status: 'CONFIRMED', source: 'PHONE', adults: 2, children: 1, typeIdx: 1 },
  { key: 'U5', inOff: 1, outOff: 3, status: 'CONFIRMED', source: 'DIRECT', adults: 2, children: 0, typeIdx: 2 },
  { key: 'U6', inOff: 1, outOff: 2, status: 'CONFIRMED', source: 'EMAIL', adults: 2, children: 0, typeIdx: 3 },
  { key: 'U7', inOff: 2, outOff: 4, status: 'CONFIRMED', source: 'OTA', adults: 2, children: 0, typeIdx: 4 },
  { key: 'U8', inOff: 3, outOff: 5, status: 'CONFIRMED', source: 'DIRECT', adults: 2, children: 2, typeIdx: 0 },
  { key: 'U9', inOff: 4, outOff: 6, status: 'CONFIRMED', source: 'CORPORATE', adults: 2, children: 0, typeIdx: 1 },
  { key: 'U10', inOff: 5, outOff: 7, status: 'CONFIRMED', source: 'DIRECT', adults: 2, children: 0, typeIdx: 2 },
  { key: 'U11', inOff: 6, outOff: 8, status: 'CONFIRMED', source: 'PHONE', adults: 1, children: 0, typeIdx: 3 },
  { key: 'U12', inOff: 7, outOff: 9, status: 'CONFIRMED', source: 'DIRECT', adults: 2, children: 0, typeIdx: 4 },
  { key: 'X1', inOff: 2, outOff: 4, status: 'CANCELLED', source: 'DIRECT', adults: 2, children: 0, typeIdx: 0 },
  { key: 'X2', inOff: 3, outOff: 5, status: 'CANCELLED', source: 'OTA', adults: 2, children: 1, typeIdx: 1 },
  { key: 'X3', inOff: 8, outOff: 10, status: 'CANCELLED', source: 'CORPORATE', adults: 2, children: 0, typeIdx: 2 },
  { key: 'N1', inOff: -2, outOff: 0, status: 'NO_SHOW', source: 'DIRECT', adults: 2, children: 0, typeIdx: 3 },
  { key: 'N2', inOff: -1, outOff: 1, status: 'NO_SHOW', source: 'OTA', adults: 1, children: 0, typeIdx: 4 },
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orgRes = await client.query(`SELECT id FROM "Organization" WHERE slug = 'demo-hospitality'`);
    if (orgRes.rowCount === 0) throw new Error('Run the main seed first: npm run db:seed');
    const organizationId = orgRes.rows[0].id as string;

    const propRes = await client.query(
      `SELECT id, "currencyCode", timezone FROM "Property" WHERE "organizationId" = $1 AND slug = 'main-hotel'`,
      [organizationId],
    );
    if (propRes.rowCount === 0) throw new Error('main-hotel property missing; run npm run db:seed');
    const propertyId = propRes.rows[0].id as string;
    const currencyCode = (propRes.rows[0].currencyCode as string) ?? 'INR';
    const timezone = (propRes.rows[0].timezone as string) ?? 'Asia/Kolkata';

    const today = businessDateFor(timezone);
    const rand = mulberry32(42);

    const rtRes = await client.query(
      `SELECT id, code, "baseRate" FROM "RoomType" WHERE "propertyId" = $1 ORDER BY code`,
      [propertyId],
    );
    if (rtRes.rows.length === 0) throw new Error('No room types; run npm run db:seed');
    const roomTypes = rtRes.rows as Array<{ id: string; code: string; baseRate: string }>;

    const roomRes = await client.query(
      `SELECT r.id, r."roomNumber", r."roomTypeId", rt."baseRate" FROM "Room" r
       JOIN "RoomType" rt ON rt.id = r."roomTypeId"
       WHERE r."propertyId" = $1 AND r."isActive" = true ORDER BY r."roomNumber"`,
      [propertyId],
    );
    const rooms = roomRes.rows as Array<{ id: string; roomNumber: string; roomTypeId: string; baseRate: string }>;
    if (rooms.length === 0) throw new Error('No rooms; run npm run db:seed');

    const userRes = await client.query(`SELECT id, email FROM "User" WHERE email IN (
      'admin@dev.local','manager@dev.local','frontdesk@dev.local','housekeeping@dev.local','auditor@dev.local')`);
    const userByEmail = new Map((userRes.rows as Array<{ id: string; email: string }>).map((u) => [u.email, u.id]));
    const adminId = userByEmail.get('admin@dev.local');
    const fdId = userByEmail.get('frontdesk@dev.local');
    const hkId = userByEmail.get('housekeeping@dev.local');
    if (!adminId) throw new Error('Dev users missing; run npm run db:dev-users first');

    // ---- clear previous demo / test transactional rows (base reference kept) ----
    await client.query(`DELETE FROM "Notification" WHERE "propertyId" = $1`, [propertyId]);
    await client.query(`DELETE FROM "AuditLog" WHERE "propertyId" = $1`, [propertyId]);
    await client.query(`DELETE FROM "Invoice" WHERE "propertyId" = $1`, [propertyId]);
    await client.query(
      `DELETE FROM "Payment" WHERE "folioId" IN (SELECT id FROM "Folio" WHERE "propertyId" = $1)`,
      [propertyId],
    );
    await client.query(
      `DELETE FROM "FolioItem" WHERE "folioId" IN (SELECT id FROM "Folio" WHERE "propertyId" = $1)`,
      [propertyId],
    );
    await client.query(`DELETE FROM "Folio" WHERE "propertyId" = $1`, [propertyId]);
    await client.query(
      `DELETE FROM "RoomNightInventory" WHERE "reservationRoomId" IN
        (SELECT rr.id FROM "ReservationRoom" rr JOIN "Reservation" r ON r.id = rr."reservationId" WHERE r."propertyId" = $1)`,
      [propertyId],
    );
    await client.query(
      `DELETE FROM "ReservationRoom" WHERE "reservationId" IN (SELECT id FROM "Reservation" WHERE "propertyId" = $1)`,
      [propertyId],
    );
    await client.query(`DELETE FROM "Reservation" WHERE "propertyId" = $1`, [propertyId]);
    await client.query(`DELETE FROM "HousekeepingTask" WHERE "propertyId" = $1`, [propertyId]);
    await client.query(`DELETE FROM "MaintenanceTicket" WHERE "propertyId" = $1`, [propertyId]);
    await client.query(`DELETE FROM "NightAudit" WHERE "propertyId" = $1`, [propertyId]);
    await client.query(`DELETE FROM "UserThemePreference" WHERE "propertyId" = $1`, [propertyId]);
    await client.query(`DELETE FROM "Guest" WHERE "organizationId" = $1`, [organizationId]);
    await client.query(
      `UPDATE "Room" SET status = 'VACANT_CLEAN', notes = NULL, "updatedAt" = NOW() WHERE "propertyId" = $1`,
      [propertyId],
    );

    // ---- 40 guests ----
    const guestIds: string[] = [];
    for (let i = 0; i < 40; i++) {
      const fn = FIRST[i % FIRST.length];
      const ln = LAST[(i * 7 + 3) % LAST.length];
      const email = `${fn.toLowerCase()}.${ln.toLowerCase()}${i}@example.com`;
      const phone = `+91 98${String(1000000 + Math.floor(rand() * 8999999))}`;
      const company = i % 4 === 0 ? COMPANIES[i % COMPANIES.length] : null;
      const prefs = i % 3 === 0 ? 'High floor, extra pillows' : i % 3 === 1 ? 'Vegetarian breakfast, quiet room' : null;
      const r = await client.query(
        `INSERT INTO "Guest" (id, "organizationId", "firstName", "lastName", email, phone, "companyName", city, "countryCode", preferences, "internalNotes", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'IN', $8, $9, NOW(), NOW()) RETURNING id`,
        [
          organizationId, fn, ln, email, phone, company,
          ['Mumbai', 'Delhi', 'Bengaluru', 'Chennai', 'Hyderabad'][i % 5],
          prefs, i % 6 === 0 ? 'VIP — handle with care' : null,
        ],
      );
      guestIds.push(r.rows[0].id as string);
    }

    // ---- room assignment (greedy, no overlaps per room) ----
    // Keep room 504 for the out-of-order story; never assign it.
    const oooRoom = rooms.find((r) => r.roomNumber === '504') ?? rooms[rooms.length - 1];
    const assignable = rooms.filter((r) => r.id !== oooRoom.id);
    const holds = new Map<string, Array<{ ci: string; co: string }>>();
    const overlaps = (a1: string, a2: string, b1: string, b2: string) => a1 < b2 && b1 < a2;

    interface Planned extends Spec {
      idx: number;
      ci: string;
      co: string;
      nights: string[];
      roomTypeId: string;
      nightlyRate: string;
      roomId: string | null;
      guestId: string;
    }
    const planned: Planned[] = [];
    SPECS.forEach((s, idx) => {
      const ci = addDays(today, s.inOff);
      const co = addDays(today, s.outOff);
      const nights = enumerateNights(ci, co);
      const rt = roomTypes[s.typeIdx % roomTypes.length];
      planned.push({
        ...s, idx, ci, co, nights,
        roomTypeId: rt.id,
        nightlyRate: Number(rt.baseRate).toFixed(2),
        roomId: null,
        guestId: guestIds[idx % guestIds.length],
      });
    });

    for (const p of planned) {
      // Cancelled / no-show release their hold: no inventory.
      if (p.status === 'CANCELLED' || p.status === 'NO_SHOW') continue;
      const candidates = assignable.filter((r) => r.roomTypeId === p.roomTypeId);
      const fallback = assignable.filter((r) => r.roomTypeId !== p.roomTypeId);
      let picked: string | null = null;
      for (const poolRooms of [candidates, fallback]) {
        for (const r of poolRooms) {
          const list = holds.get(r.id) ?? [];
          if (list.every((h) => !overlaps(p.ci, p.co, h.ci, h.co))) {
            picked = r.id;
            // If we fell back to another type, the reservation takes that type.
            p.roomTypeId = r.roomTypeId;
            const rtRow = roomTypes.find((t) => t.id === r.roomTypeId);
            if (rtRow) p.nightlyRate = Number(rtRow.baseRate).toFixed(2);
            break;
          }
        }
        if (picked) break;
      }
      if (picked) {
        p.roomId = picked;
        holds.set(picked, [...(holds.get(picked) ?? []), { ci: p.ci, co: p.co }]);
      }
    }

    // ---- reservations + rooms + inventory ----
    const resIds: Record<string, string> = {};
    const folioByRes: Record<string, { id: string; folioNo: string }> = {};
    let folioSeq = 1;
    for (const [i, p] of planned.entries()) {
      const rate = fromDecimal(p.nightlyRate);
      const subtotal = { minor: rate.minor * p.nights.length };
      const tax = applyPercent(subtotal, 18);
      const total = { minor: subtotal.minor + tax.minor };
      const bookingCode = `RSV-DM-${String(i + 1).padStart(4, '0')}`;
      const source = SOURCES[i % SOURCES.length];
      const ins = await client.query(
        `INSERT INTO "Reservation" (id, "propertyId", "bookingCode", status, source, "primaryGuestId", "createdById",
          "checkInDate", "checkOutDate", adults, children, "currencyCode", subtotal, "taxTotal", "totalAmount",
          "specialRequests", "cancellationReason", "cancelledAt", "checkedInAt", "checkedOutAt", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3::"ReservationStatus", $4::"BookingSource", $5, $6,
          $7::date, $8::date, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW(), NOW())
         RETURNING id`,
        [
          propertyId, bookingCode, p.status, source, p.guestId, adminId,
          p.ci, p.co, p.adults, p.children, currencyCode,
          toDecimal(subtotal), toDecimal(tax), toDecimal(total),
          p.note ?? null,
          p.status === 'CANCELLED' ? 'Guest request — plans changed' : null,
          p.status === 'CANCELLED' ? new Date().toISOString() : null,
          p.status === 'CHECKED_IN' || p.status === 'CHECKED_OUT' ? `${p.ci}T08:30:00Z` : null,
          p.status === 'CHECKED_OUT' ? `${p.co}T06:30:00Z` : null,
        ],
      );
      const resId = ins.rows[0].id as string;
      resIds[p.key] = resId;

      const rr = await client.query(
        `INSERT INTO "ReservationRoom" (id, "reservationId", "roomTypeId", "roomId", adults, children, "nightlyRate", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING id`,
        [resId, p.roomTypeId, p.roomId, p.adults, p.children, p.nightlyRate],
      );
      const rrId = rr.rows[0].id as string;

      if (p.roomId) {
        for (const night of p.nights) {
          await client.query(
            `INSERT INTO "RoomNightInventory" (id, "roomId", "reservationRoomId", "stayDate", "createdAt")
             VALUES (gen_random_uuid(), $1, $2, $3::date, NOW())`,
            [p.roomId, rrId, night],
          );
        }
      }

      // Folios open at check-in, not at booking: only stays that began.
      if (p.status === 'CHECKED_IN' || p.status === 'CHECKED_OUT') {
        const folioNo = `F-DM-${String(folioSeq++).padStart(4, '0')}`;
        const closed = p.status === 'CHECKED_OUT';
        const f = await client.query(
          `INSERT INTO "Folio" (id, "propertyId", "reservationId", "folioNo", status, "currencyCode", "openedAt", "closedAt", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, $4::"FolioStatus", $5, $6::timestamptz, $7::timestamptz, NOW(), NOW()) RETURNING id`,
          [
            propertyId, resId, folioNo, closed ? 'CLOSED' : 'OPEN', currencyCode,
            `${p.ci}T08:35:00Z`, closed ? `${p.co}T07:00:00Z` : null,
          ],
        );
        folioByRes[p.key] = { id: f.rows[0].id as string, folioNo };
      }
    }

    // ---- folio items + payments + invoices ----
    const taxSnapshot = JSON.stringify([{ code: 'GST18', ratePercent: 18, isInclusive: false }]);
    let paySeq = 1;
    let invSeq = 1;
    const folioTotals: Record<string, { charges: number; tax: number; total: number }> = {};

    for (const p of planned) {
      const folio = folioByRes[p.key];
      if (!folio) continue;
      const rate = fromDecimal(p.nightlyRate);
      const lineTax = applyPercent(rate, 18);

      // Nights posted: past stays fully; current stays up to tonight.
      const postable = p.status === 'CHECKED_OUT'
        ? p.nights
        : p.nights.filter((n) => n <= today);
      let n = 0;
      for (const night of postable) {
        n += 1;
        await client.query(
          `INSERT INTO "FolioItem" (id, "folioId", type, description, quantity, "unitAmount", "taxAmount", "taxSnapshot", "totalAmount", "postedById", "idempotencyKey", "isVoided", "createdAt")
           VALUES (gen_random_uuid(), $1, 'ROOM_CHARGE', $2, '1', $3, $4, $5::jsonb, $6, $7, $8, false, NOW())`,
          [
            folio.id, `Room charge, night ${n} (${night})`, p.nightlyRate,
            toDecimal(lineTax), taxSnapshot, p.nightlyRate, fdId ?? adminId,
            `room-charge:demo:${p.key}:n${n}`,
          ],
        );
      }

      // Incidentals on ~60% of stayed folios.
      let chargesMinor = rate.minor * postable.length;
      let taxMinor = lineTax.minor * postable.length;
      if (postable.length > 0 && rand() < 0.6) {
        const extra = INCIDENTALS[Math.floor(rand() * INCIDENTALS.length)];
        const amt = fromDecimal(extra.amount);
        const extraTax = applyPercent(amt, 18);
        await client.query(
          `INSERT INTO "FolioItem" (id, "folioId", type, description, quantity, "unitAmount", "taxAmount", "taxSnapshot", "totalAmount", "postedById", "idempotencyKey", "isVoided", "createdAt")
           VALUES (gen_random_uuid(), $1, 'INCIDENTAL', $2, '1', $3, $4, $5::jsonb, $6, $7, $8, false, NOW())`,
          [
            folio.id, extra.desc, extra.amount, toDecimal(extraTax),
            taxSnapshot, extra.amount, fdId ?? adminId, `incidental:demo:${p.key}`,
          ],
        );
        chargesMinor += amt.minor;
        taxMinor += extraTax.minor;
      }
      const totalMinor = chargesMinor + taxMinor;
      folioTotals[p.key] = { charges: chargesMinor, tax: taxMinor, total: totalMinor };

      // Payments: past fully settled; current mixed (full / half / unpaid).
      const totalStr = toDecimal({ minor: totalMinor });
      const method = METHODS[Math.floor(rand() * METHODS.length)];
      const pay = async (amountMinor: number, ref: string) => {
        await client.query(
          `INSERT INTO "Payment" (id, "folioId", amount, "currencyCode", method, status, reference, "receivedById", "idempotencyKey", "recordedAt", "settledAt", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, $4::"PaymentMethod", 'SUCCEEDED', $5, $6, $7, NOW(), NOW(), NOW(), NOW())`,
          [folio.id, toDecimal({ minor: amountMinor }), currencyCode, method, ref, fdId ?? adminId, `pay:demo:${p.key}:${paySeq++}`],
        );
      };
      if (p.status === 'CHECKED_OUT') {
        await pay(totalMinor, `DEMO-SETTLE-${p.key}`);
      } else {
        if (['C1', 'C4'].includes(p.key)) await pay(totalMinor, `DEMO-SETTLE-${p.key}`);
        else if (['C2', 'C5', 'C7'].includes(p.key)) await pay(Math.floor(totalMinor / 2), `DEMO-PART-${p.key}`);
        // C3, C6, C8 left unpaid to show balances.
      }

      // Invoices for 8 of the 10 past stays: 7 issued, 1 void.
      if (p.status === 'CHECKED_OUT') {
        const pastIdx = Number(p.key.slice(1));
        if (pastIdx <= 7 || pastIdx === 8) {
          const voided = pastIdx === 8;
          const invoiceNo = `INV-DM-${String(invSeq++).padStart(4, '0')}`;
          await client.query(
            `INSERT INTO "Invoice" (id, "propertyId", "folioId", "invoiceNo", status, "currencyCode", subtotal, "taxTotal", "totalAmount", "issuedAt", "voidedAt", "voidReason", "createdAt", "updatedAt")
             VALUES (gen_random_uuid(), $1, $2, $3, $4::"InvoiceStatus", $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11, NOW(), NOW())`,
            [
              propertyId, folio.id, invoiceNo, voided ? 'VOID' : 'ISSUED', currencyCode,
              toDecimal({ minor: chargesMinor }), toDecimal({ minor: taxMinor }), totalStr,
              `${p.co}T07:30:00Z`, voided ? new Date().toISOString() : null,
              voided ? 'Duplicate raised in error — original stands' : null,
            ],
          );
        }
      }
    }

    // ---- room statuses match reality ----
    const occupiedRoomIds = new Set(
      planned.filter((p) => p.status === 'CHECKED_IN' && p.roomId).map((p) => p.roomId as string),
    );
    const heldRoomIds = new Set(
      planned.filter((p) => p.roomId).map((p) => p.roomId as string),
    );
    const freeRooms = assignable.filter((r) => !heldRoomIds.has(r.id) && !occupiedRoomIds.has(r.id));
    // One occupied room stays dirty to show the OCCUPIED_DIRTY state.
    const occupiedList = [...occupiedRoomIds];
    const dirtyOccupied = occupiedList[0];
    for (const rid of occupiedList) {
      await client.query(`UPDATE "Room" SET status = $2, "updatedAt" = NOW() WHERE id = $1`, [
        rid, rid === dirtyOccupied ? 'OCCUPIED_DIRTY' : 'OCCUPIED_CLEAN',
      ]);
    }
    // Two free rooms dirty, two inspected, rest clean.
    const dirtyVacant = freeRooms.slice(0, 2);
    const inspected = freeRooms.slice(2, 4);
    for (const r of dirtyVacant) {
      await client.query(`UPDATE "Room" SET status = 'VACANT_DIRTY', "updatedAt" = NOW() WHERE id = $1`, [r.id]);
    }
    for (const r of inspected) {
      await client.query(`UPDATE "Room" SET status = 'INSPECTED', "updatedAt" = NOW() WHERE id = $1`, [r.id]);
    }
    await client.query(`UPDATE "Room" SET status = 'OUT_OF_ORDER', notes = 'AC not cooling — compressor fault', "updatedAt" = NOW() WHERE id = $1`, [oooRoom.id]);

    // ---- 20 housekeeping tasks ----
    const hkTypes = ['CHECKOUT_CLEAN', 'STAYOVER_CLEAN', 'INSPECTION', 'TURNDOWN', 'LINEN_CHANGE', 'SPECIAL_REQUEST'] as const;
    const hkStatuses = ['TODO', 'IN_PROGRESS', 'CLEANED', 'INSPECTION_REQUIRED', 'READY', 'BLOCKED'] as const;
    const taskRooms = [...dirtyVacant.map((r) => r.id), ...occupiedList.slice(0, 6), ...inspected.map((r) => r.id), ...assignable.slice(0, 10).map((r) => r.id)];
    for (let i = 0; i < 20; i++) {
      const roomId = taskRooms[i % taskRooms.length];
      const type = i < dirtyVacant.length ? 'CHECKOUT_CLEAN' : hkTypes[i % hkTypes.length];
      let status: string = hkStatuses[i % hkStatuses.length];
      // Keep the one-open-task-per-room rule satisfiable: vary types.
      if (i >= 6) status = ['TODO', 'IN_PROGRESS', 'TODO', 'READY', 'TODO', 'CANCELLED'][i % 6];
      await client.query(
        `INSERT INTO "HousekeepingTask" (id, "propertyId", "roomId", type, priority, status, "assignedToId", "createdById", "dueAt", notes, "blockedReason", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3::"HousekeepingTaskType", $4::"TaskPriority", $5::"HousekeepingTaskStatus", $6, $7, NOW() + ($8 || ' hours')::interval, $9, $10, NOW(), NOW())`,
        [
          propertyId, roomId, type,
          i % 5 === 0 ? 'HIGH' : i % 7 === 0 ? 'URGENT' : 'NORMAL',
          status, i % 2 === 0 ? hkId : null, adminId, String((i % 24) + 1),
          type === 'CHECKOUT_CLEAN' ? 'Turnover clean after departure' : `Demo task ${i + 1}`,
          status === 'BLOCKED' ? 'Waiting on maintenance — leaking tap' : null,
        ],
      ).catch(() => {
        // One-open-task-per-room guard may reject a duplicate; skip quietly.
      });
    }

    // ---- 10 maintenance tickets (one backs the out-of-order room) ----
    const maint: Array<{ title: string; desc: string; cat: string; pri: string; st: string; room: string | null }> = [
      { title: 'AC not cooling', desc: 'Room reports warm air; suspect compressor fault. Room taken out of order.', cat: 'HVAC', pri: 'CRITICAL', st: 'OPEN', room: oooRoom.id },
      { title: 'Leaking tap', desc: 'Bathroom tap drips continuously.', cat: 'PLUMBING', pri: 'HIGH', st: 'ASSIGNED', room: dirtyVacant[0]?.id ?? null },
      { title: 'Flickering hallway light', desc: 'Floor 2 hallway flickers intermittently.', cat: 'ELECTRICAL', pri: 'NORMAL', st: 'OPEN', room: null },
      { title: 'Wardrobe hinge loose', desc: 'Door hangs low, needs re-hang.', cat: 'FURNITURE', pri: 'LOW', st: 'IN_PROGRESS', room: assignable[0]?.id ?? null },
      { title: 'Mini-bar fridge noisy', desc: 'Rattling compressor at night.', cat: 'APPLIANCE', pri: 'NORMAL', st: 'OPEN', room: occupiedList[1] ?? null },
      { title: 'Smoke detector beep', desc: 'Low-battery chirp every minute.', cat: 'SAFETY', pri: 'HIGH', st: 'RESOLVED', room: assignable[1]?.id ?? null },
      { title: 'Wi-Fi dead spot', desc: 'Weak signal on floor 4 west wing.', cat: 'IT', pri: 'NORMAL', st: 'OPEN', room: null },
      { title: 'Shower pressure low', desc: 'Trickle on top floor.', cat: 'PLUMBING', pri: 'NORMAL', st: 'CLOSED', room: assignable[2]?.id ?? null },
      { title: 'Curtain rail broken', desc: 'Rail pulled from wall.', cat: 'FURNITURE', pri: 'LOW', st: 'OPEN', room: assignable[3]?.id ?? null },
      { title: 'Lobby door closer slams', desc: 'Adjust tension.', cat: 'OTHER', pri: 'LOW', st: 'RESOLVED', room: null },
    ];
    let mxSeq = 1;
    for (const m of maint) {
      await client.query(
        `INSERT INTO "MaintenanceTicket" (id, "propertyId", "roomId", "ticketNo", title, description, category, priority, status, "reportedById", "assignedToId", resolution, "resolvedAt", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::"MaintenanceCategory", $7::"MaintenancePriority", $8::"MaintenanceStatus", $9, $10, $11, $12::timestamptz, NOW(), NOW())`,
        [
          propertyId, m.room, `MX-DM-${String(mxSeq++).padStart(4, '0')}`, m.title, m.desc,
          m.cat, m.pri, m.st, hkId ?? adminId, m.st === 'OPEN' ? null : adminId,
          m.st === 'RESOLVED' || m.st === 'CLOSED' ? 'Fixed and verified by supervisor' : null,
          m.st === 'RESOLVED' || m.st === 'CLOSED' ? new Date().toISOString() : null,
        ],
      );
    }

    // ---- night audits: last 7 completed + today previewed ----
    for (let back = 7; back >= 1; back--) {
      const d = addDays(today, -back);
      await client.query(
        `INSERT INTO "NightAudit" (id, "propertyId", "businessDate", status, "startedById", "completedById", "finalSummary", "idempotencyKey", "startedAt", "completedAt", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2::date, 'COMPLETED', $3, $3, $4::jsonb, $5, NOW(), NOW(), NOW(), NOW())`,
        [
          propertyId, d, adminId,
          JSON.stringify({ businessDate: d, roomsSold: 8 + (back % 5), roomRevenue: '28500.00', note: 'Demo close' }),
          `night-audit:demo:${d}`,
        ],
      );
    }
    await client.query(
      `INSERT INTO "NightAudit" (id, "propertyId", "businessDate", status, "startedById", "previewSummary", "idempotencyKey", "startedAt", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2::date, 'PREVIEWED', $3, $4::jsonb, $5, NOW(), NOW(), NOW())`,
      [
        propertyId, today, adminId,
        JSON.stringify({ businessDate: today, expectedArrivals: 4, expectedDepartures: 3, inHouse: 8 }),
        `night-audit:demo:${today}:preview`,
      ],
    );

    // ---- notifications for the dev users ----
    const notifTargets = [adminId, userByEmail.get('manager@dev.local'), fdId, hkId].filter(Boolean) as string[];
    const notifs: Array<{ type: string; title: string; body: string; path: string }> = [
      { type: 'ARRIVAL', title: '4 arrivals due today', body: '4 confirmed reservations arrive today. 2 rooms still need inspection.', path: '/arrivals' },
      { type: 'DEPARTURE', title: '3 departures today', body: '3 checked-in stays depart today. 1 has an open balance.', path: '/departures' },
      { type: 'HOUSEKEEPING', title: 'Turnover cleans pending', body: '2 checkout cleans are TODO on vacant-dirty rooms.', path: '/housekeeping' },
      { type: 'MAINTENANCE', title: 'CRITICAL: AC fault in 504', body: 'Room 504 is out of order with an open critical ticket.', path: '/maintenance' },
      { type: 'PAYMENT', title: 'Partial payments in house', body: '3 in-house folios carry a partial payment. Balances are on the folio.', path: '/billing' },
      { type: 'RESERVATION', title: 'Weekend pickup', body: '6 new nights booked for the coming weekend across deluxe and suite.', path: '/reservations' },
      { type: 'NIGHT_AUDIT', title: "Today's audit preview ready", body: 'Night audit preview for today is available for review.', path: '/reports' },
      { type: 'SYSTEM', title: 'Demo data loaded', body: 'Transactional demo data was seeded. Use it to click through every flow.', path: '/dashboard' },
    ];
    for (const [i, nf] of notifs.entries()) {
      await client.query(
        `INSERT INTO "Notification" (id, "userId", "propertyId", type, title, body, "targetPath", "createdAt")
         VALUES (gen_random_uuid(), $1, $2, $3::"NotificationType", $4, $5, $6, NOW())`,
        [notifTargets[i % notifTargets.length], propertyId, nf.type, nf.title, nf.body, nf.path],
      );
    }

    // ---- theme prefs: one per dev user so all 8 themes render somewhere ----
    const themes: Array<[string | undefined, string]> = [
      [adminId, 'MIDNIGHT_NAVY'],
      [userByEmail.get('manager@dev.local'), 'SKY_BLUE_WHITE'],
      [fdId, 'LUXURY_BEIGE_TAUPE'],
      [hkId, 'SAGE_GREEN'],
      [userByEmail.get('auditor@dev.local'), 'DUSTY_LAVENDER'],
    ];
    for (const [uid, theme] of themes) {
      if (!uid) continue;
      await client.query(
        `INSERT INTO "UserThemePreference" (id, "userId", "propertyId", "themeKey", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3::"ThemeKey", NOW())
         ON CONFLICT ("userId", "propertyId") DO UPDATE SET "themeKey" = EXCLUDED."themeKey", "updatedAt" = NOW()`,
        [uid, propertyId, theme],
      );
    }

    // ---- audit rows for what was created ----
    for (const [i, p] of planned.entries()) {
      const resId = resIds[p.key];
      if (!resId) continue;
      await client.query(
        `INSERT INTO "AuditLog" (id, "organizationId", "propertyId", "actorUserId", action, "resourceType", "resourceId", outcome, metadata, "createdAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 'reservation.create', 'Reservation', $4, 'SUCCESS', $5::jsonb, NOW())`,
        [organizationId, propertyId, adminId, resId, JSON.stringify({ bookingCode: `RSV-DM-${String(i + 1).padStart(4, '0')}`, nights: p.nights.length, demo: true })],
      );
    }

    await client.query('COMMIT');

    const counts: Record<string, number> = {};
    for (const t of ['Guest', 'Reservation', 'ReservationRoom', 'RoomNightInventory', 'Folio', 'FolioItem', 'Payment', 'Invoice', 'HousekeepingTask', 'MaintenanceTicket', 'NightAudit', 'Notification', 'AuditLog']) {
      const r = await client.query(`SELECT count(*)::int AS n FROM "${t}"`);
      counts[t] = r.rows[0].n as number;
    }
    console.info(`Demo seed complete for business date ${today} (${currencyCode}).`);
    console.info(JSON.stringify(counts, null, 2));
    console.info('Arrivals today (CONFIRMED): 4 · Departures today (CHECKED_IN): 3 · In-house: 8.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

main()
  .catch((e) => {
    console.error('seed-demo failed:', e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
