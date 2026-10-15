# PMS backend (NestJS + PostgreSQL)

See the repo root [`README.md`](../README.md) for the full runbook. Backend-only
summary:

```bash
npm install
npm run contract:emit
npm run db:migrate
npm run db:reseed    # truncate + seed + dev-users + demo data (hand this to someone new)
npm run dev:all     # gateway (HTTP :3000) + auth microservice, both watching
```

## Processes

This backend runs as three processes that talk over Redis:

| Process | Entry | Role |
|---|---|---|
| **Gateway** | `src/main.ts` (`npm run start:dev`) | Owns the HTTP API, cookies, CSRF, throttling, and every domain module. Forwards auth and booking commands to the services, and streams live room availability (SSE). |
| **Auth microservice** | `src/auth-service/main.ts` (`npm run start:auth:dev`) | Owns session, staff, role and permission state. Redis transport, no HTTP. |
| **Booking microservice** | `src/booking-service/main.ts` (`npm run start:booking:dev`) | Owns reservations, stays (check-in/out/extend), folios, invoices and the Redis room holds. Redis transport, no HTTP. |

All three share one PostgreSQL database and the same `AuditService`. The public
API and the frontend are unchanged — the gateway keeps every `/api/v1` route.

Run them together with `npm run dev:all`, or separately with `npm run start:dev`,
`npm run start:auth:dev` and `npm run start:booking:dev`. A local broker is
required:

```bash
docker run -d --name redis -p 6379:6379 redis
```

`GET /api/v1/health/auth` checks the gateway → Redis → auth-service path.

### Room holds (double-booking guard)

Holds are **database-backed**. A hold is one `RoomNightInventory` row per
room-night with `holdToken` / `holdUserId` / `holdExpiresAt` set and
`reservationRoomId` null; a booking is the *same* row with `reservationRoomId`
set. Because the table keeps `@@unique([roomId, stayDate])`, that one constraint
is the authority that stops two users claiming the same night — enforced by
Postgres, across every application instance.

- `POST /api/v1/availability/hold` acquires a **10-minute hold** on every night of
  the stay in one transaction (a lost race is a unique violation ⇒ **409**).
- Availability and booking ignore expired holds, so a lapsed hold never blocks a
  new user even before the sweep runs.
- `POST /availability/holds/:holdId/refresh` extends; `DELETE /availability/holds/:holdId`
  releases (ownership checked).
- A booking **requires a physical room and a valid hold**; the hold is converted
  into the booking inside the booking transaction, so a stale or expired token is
  rejected with **409**. An `idempotencyKey` makes a retried create return the
  same booking instead of creating a second one.
- A scheduled sweep (`@nestjs/schedule`, every 60 seconds) deletes expired hold
  rows; it is idempotent, so several booking-service instances can run it safely.
- `GET /api/v1/availability/stream` (SSE) pushes hold/release/book/cancel events
  so other browsers update immediately. Redis carries only these events — it is
  not the source of truth.

| Command | What it does |
|---|---|
| `npm run db:truncate` | `TRUNCATE … CASCADE` all public tables, schema kept |
| `npm run db:seed` | org, property, permissions, 5 roles, room types, rooms + wings, GST18, 3 rate plans + 75 nights of prices |
| `npm run db:dev-users` | 5 role logins (`DevPass!2026`) + `annex-property` for isolation tests (dev only) |
| `npm run db:seed:demo` | 40 guests, 35 stays (past / in-house / upcoming / cancelled / no-show), 18 folios, payments, invoices, 20 housekeeping tasks, 10 maintenance tickets, 8 night audits, notifications, theme prefs, audit rows |
| `npm run db:verify:counts` | row counts for all 27 tables + inventory/type reconciliation |
| `npm run db:reset` | full schema rebuild (drops `public` + ledger, re-migrates, reference seed only) |

API: <http://localhost:3000/api/v1>, Swagger at <http://localhost:3000/docs> (dev).
