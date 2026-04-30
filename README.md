# ClosetX Backend

Node.js + TypeScript + Fastify + Drizzle + PostgreSQL.

Source-of-truth specs are in the parent directory:

- `../PRODUCT_SPEC.md` — behavioural product spec
- `../USER_STORIES.md` — retailer + admin user stories
- `../UI_FLOW.md` — page-by-page UI flow for the dashboards
- ERD on Eraser
- DFD on Eraser

## Stack

| Layer | Pick |
|---|---|
| Runtime | Node.js 20+ LTS |
| Language | TypeScript (strict mode) |
| HTTP | Fastify + `fastify-type-provider-zod` |
| Database | PostgreSQL 16 |
| DB layer | Drizzle ORM + Drizzle Kit migrations |
| Validation | Zod |
| Auth | Custom JWT + refresh rotation (3 identity domains) |
| Background jobs | pg-boss |
| Logger | pino |
| Testing | Vitest |

## Running locally

```sh
# 1. Postgres 16 must be running locally on :5432.
#    Create a db + user that match DATABASE_URL in .env:
#       psql -U postgres
#       CREATE USER closetx WITH PASSWORD 'closetx';
#       CREATE DATABASE closetx_dev OWNER closetx;

# 2. Install deps
npm install

# 3. Set env
cp .env.example .env
# (edit JWT secrets to be 32+ random chars; adjust DATABASE_URL if needed)

# 4. Generate the first migration once schemas exist (Phase 1)
npm run db:generate
npm run db:migrate

# 5. Boot the dev server
npm run dev
```

## Scripts

| Command | Effect |
|---|---|
| `npm run dev` | Run the API with watch mode (tsx) |
| `npm run typecheck` | TypeScript check, no emit |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format` / `format:check` | Prettier |
| `npm test` / `test:watch` | Vitest |
| `npm run db:generate` | Generate SQL migration from schema diff |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:push` | Push schema without migration (dev shortcut, avoid in prod) |
| `npm run db:studio` | Open Drizzle Studio (browse data) |
| `npm run db:seed` | Run seed scripts (NOT auto-run) |

## Repo layout

See the development plan at `~/.claude/plans/the-product-specs-misses-shimmying-falcon.md` for the full structure and phase plan.

## Spec questions tracker

When you hit an ambiguity in the spec, log it in `SPEC_QUESTIONS.md` with a proposed answer. The spec owner will respond inline. Avoid spec-doc rewrites until the question is resolved.
