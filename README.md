# PMS backend (NestJS + PostgreSQL)

See the repo root [`README.md`](../README.md) for the full runbook. Backend-only
summary:

```bash
npm install
npm run contract:emit
npm run db:migrate
npm run db:reseed    # truncate + seed + dev-users + demo data (hand this to someone new)
npm run start:dev
```

| Command | What it does |
|---|---|
| `npm run db:truncate` | `TRUNCATE … CASCADE` all public tables, schema kept |
| `npm run db:seed` | org, property, permissions, 5 roles, room types, rooms + wings, GST18, 3 rate plans + 75 nights of prices |
| `npm run db:dev-users` | 5 role logins (`DevPass!2026`) + `annex-property` for isolation tests (dev only) |
| `npm run db:seed:demo` | 40 guests, 35 stays (past / in-house / upcoming / cancelled / no-show), 18 folios, payments, invoices, 20 housekeeping tasks, 10 maintenance tickets, 8 night audits, notifications, theme prefs, audit rows |
| `npm run db:verify:counts` | row counts for all 27 tables + inventory/type reconciliation |
| `npm run db:reset` | full schema rebuild (drops `public` + ledger, re-migrates, reference seed only) |

API: <http://localhost:3000/api/v1>, Swagger at <http://localhost:3000/docs> (dev).
