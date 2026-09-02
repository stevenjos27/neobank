# NeoBank

[![CI](https://github.com/stevenjos27/neobank/actions/workflows/ci.yml/badge.svg)](https://github.com/stevenjos27/neobank/actions/workflows/ci.yml)

A full-stack banking application built with Indian retail-banking conventions: SAVINGS and CURRENT accounts in INR, balances stored as paise, and money movement that is transactionally safe under concurrent load.

**Live:** [neobank-smoky.vercel.app](https://neobank-smoky.vercel.app) · **API:** [/api/health](https://neobank-0erb.onrender.com/api/health) · **API docs:** [Swagger](https://neobank-0erb.onrender.com/docs)

> The API runs on Render's free tier and sleeps when idle — the first request after a quiet period can take 30–60 seconds.

## Stack

| Layer    | Choice                                                   |
| -------- | -------------------------------------------------------- |
| Monorepo | Nx                                                       |
| API      | NestJS, Prisma 7, PostgreSQL (pgvector image)            |
| Web      | Next.js (App Router), React 19, Tailwind v4, shadcn/ui   |
| Auth     | argon2 + JWT (15m access / 7d refresh), httpOnly cookies |
| Tests    | Jest, Testing Library, Playwright                        |
| Hosting  | Vercel (web), Render (API), Neon (Postgres)              |

## Architecture

The browser never talks to the API directly. Next.js route handlers act as a **backend-for-frontend**: they call the NestJS API server-to-server and store the resulting JWTs in `httpOnly`, `Secure`, `SameSite=Lax` cookies.

```
browser ──same-origin──▶ Next.js route handlers ──Bearer──▶ NestJS API ──▶ Postgres
             (cookies)          (BFF, holds tokens)
```

Consequences worth noting:

- **No token is ever readable by JavaScript**, so an XSS bug cannot exfiltrate a session.
- **Token refresh is invisible.** The access cookie's `maxAge` mirrors the JWT's 15-minute life, so "access cookie missing, refresh cookie present" _is_ the expiry signal. `proxy.ts` catches that on any request, refreshes server-side, rewrites the request's own cookie header so the in-flight request succeeds, and sets fresh cookies on the response.
- **The client bundle contains no secrets and no API URL** — the only server-side config the web app needs is `API_URL`.

### Money safety

Balances are `BigInt` paise, never floats. Transfers run inside `prisma.$transaction` with an atomic conditional decrement (`updateMany` with `balancePaise: { gte: amount }`), so there is no check-then-act race — proven by an e2e test that fires 10 concurrent transfers and asserts exactly two succeed with no money created or destroyed.

### Ownership

Every account operation derives `userId` from the verified JWT, never from the request body. Reading, depositing into, or transferring from an account you don't own returns the same response as an account that doesn't exist (404 / vague 400), so account IDs can't be enumerated.

## Running locally

Prerequisites: Node 24, pnpm, Docker.

```bash
pnpm install
docker compose up -d                 # Postgres on :5432
cp .env.example .env                 # then fill in the values
pnpm prisma migrate deploy
pnpm prisma generate

pnpm nx serve api                    # http://localhost:3000/api
pnpm nx dev web                      # http://localhost:4200
```

`.env` (repo root, API):

```
DATABASE_URL="postgresql://neobank:neobank_dev@localhost:5432/neobank"
JWT_ACCESS_SECRET="dev-access-secret-change-me"
JWT_REFRESH_SECRET="dev-refresh-secret-change-me"
WEB_ORIGINS="http://localhost:4200"
```

`apps/web/.env.local` (web):

```
API_URL=http://localhost:3000/api
```

Missing variables fail fast at boot rather than surfacing as confusing runtime errors.

## Tests

```bash
pnpm nx test api        # unit: services, money-safety guards, ownership
pnpm nx e2e api-e2e     # HTTP: auth, transfers, concurrency, ownership
pnpm nx test web        # unit: money formatting, login form
pnpm nx e2e web-e2e     # Playwright: register → account → deposit → transfer → history
```

CI runs all four against a Postgres service container on every push.

## Project structure

```
apps/
  api/        NestJS — auth, accounts, transfers, transactions
  api-e2e/    HTTP-level tests against a real server + database
  web/        Next.js — BFF route handlers, dashboard, auth pages
  web-e2e/    Playwright user-journey test
prisma/       schema and migrations
```

## Known gaps

Deliberate, deferred rather than overlooked:

- Refresh tokens are stateless — no server-side revocation or logout-everywhere.
- Account numbers are generated randomly with no collision retry.
- Transfers require the recipient's account **ID**; a real bank would look up by account number + IFSC.
- No rate limiting or `helmet`.
- The `Payee` model (with IFSC) exists in the schema but has no endpoints yet.
- Admins reuse the customer dashboard, which shows every account — the admin surface gets its own UI in a later phase.

## Roadmap

- [x] **Phase 1** — NestJS API, Prisma, auth, money-safe transfers, deployed
- [x] **Phase 2** — Next.js customer web app, BFF auth, dashboard, transfers, history
- [ ] **Phase 3** — AI features over pgvector (OpenAI, provider-agnostic wrapper)
- [ ] **Phase 4** — Angular admin surface
- [ ] **Phase 5** — Flutter mobile app

## Demo credentials

| Email                 | Password     | Role     |
| --------------------- | ------------ | -------- |
| `admin@neobank.test`  | `Demo@12345` | ADMIN    |
| `steven@neobank.test` | `Demo@12345` | CUSTOMER |
| `priya@neobank.test`  | `Demo@12345` | CUSTOMER |

Seed with `pnpm db:seed` · reset everything with `pnpm db:reset` · check ledger integrity with `pnpm db:verify`.
