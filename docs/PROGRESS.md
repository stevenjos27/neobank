# NeoBank — Progress Log

## Phase 0 — Foundations ✅ Complete

### What we accomplished
- Installed and verified the full Mac toolchain.
- Created the `neobank` Nx monorepo, pushed to GitHub, added a shared `utils` library with a passing Jest test.
- Set up GitHub Actions CI (lint + test + build on every push/PR) — badge is green.

### Environment
| Tool | Version | Notes |
|---|---|---|
| Node | v24 LTS | Managed by nvm; default resolves to `lts/*`. |
| pnpm | 11.12.0 | Pinned via `packageManager` field. pnpm v10+ blocks install scripts — use `pnpm approve-builds` when needed. |
| Nx | 23.1.0 | Integrated monorepo, `apps` preset. |
| Docker | 29.6.1 | For Phase 1 Postgres. |

- **Repo:** https://github.com/stevenjos27/neobank (public, personal account)
- **Local path:** `~/Developer/projects/neobank`
- **Structure:** `libs/utils` (Jest + ESLint + tsc). Conventional Commits in use.

### Locked decisions
- Strategy: lean MVP first — deployable full-stack + AI app by ~Week 6, then adding Angular + Flutter.
- Timeline: ~12 weeks full-time.
- AI stack: OpenAI (gpt-4o-mini + text-embedding-3-small), provider-agnostic; vectors in pgvector.
- Full stack: NestJS · PostgreSQL + Prisma · React/Next.js · Angular · Flutter.

### Next — Phase 1: Backend (NestJS + Postgres + Auth)
Documented, tested, deployed REST API. Auth (argon2 + JWT + RBAC), Prisma schema (User/Account/Transaction/Payee), money-safe DB transactions, Swagger docs, Jest + supertest, deploy to Railway/Render + Neon/Supabase.
**DoD:** live API URL, Swagger online, auth working, tests green in CI, secrets in env vars.
