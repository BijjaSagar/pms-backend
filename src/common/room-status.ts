import { db } from '../prisma/db.js';
import { brand } from '../prisma/compat.js';

/**
 * The most recent out-of-order reason for each room, read from the audit trail.
 *
 * Read straight from the audit log so the reason has exactly one home rather
 * than a duplicated column that could drift from the event that set it. Nothing
 * guest- or money-related is returned.
 */
export async function latestOutOfOrderReasons(
  roomIds: string[],
): Promise<Map<string, { reason: string; at: string }>> {
  const out = new Map<string, { reason: string; at: string }>();
  if (roomIds.length === 0) return out;

  // AuditLog.resourceId is a nullable varchar rather than a uuid, so the filter
  // is applied here instead of in the query.
  const wanted = new Set(roomIds);
  const rows = await db.orm.public.AuditLog
    .where({ action: brand('room.out-of-order') })
    .all();

  const byRoom = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const id = r.resourceId ? String(r.resourceId) : null;
    if (!id || !wanted.has(id)) continue;
    const prev = byRoom.get(id);
    if (!prev || String(r.createdAt) > String(prev.createdAt)) byRoom.set(id, r);
  }

  for (const [roomId, row] of byRoom) {
    out.set(roomId, { reason: String(row.reason ?? ''), at: String(row.createdAt) });
  }
  return out;
}
