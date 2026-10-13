# Local setup without Docker

`docker-compose.yml` only provides two things for development: **PostgreSQL 16**
and a **Redis-compatible server** (Valkey), which is optional in development. You can run both natively instead.
Nothing else in ActualPay needs Docker.

## 1. Install the services

- **PostgreSQL 16.** Use your platform's installer or package manager
  (the official Windows installer, `brew install postgresql@16`, or your
  Linux distribution's `postgresql-16` package). Remember the password you set
  for the `postgres` superuser. Make sure the server is running and listening
  on `localhost:5432`.
- **Valkey or Redis (optional for development).** You can skip it entirely:
  leave `REDIS_URL` empty in `.env` and the API counts rate limits in its own
  memory (per process, reset on restart; a warning is logged at startup).
  Production requires it. If you want a real one, install it natively on
  Linux or macOS (`brew install valkey`, or your distribution's `valkey` /
  `redis` package), or on Windows run it inside WSL2 or use a Windows-native
  Redis-compatible server. Set a password (`requirepass`) and listen on
  `localhost:6379`.

If something else already uses port 5432 or 6379, either stop it or use other
ports and put them in the URLs in `.env`.

## 2. Configure `.env`

```bash
cp .env.example .env     # PowerShell: Copy-Item .env.example .env
```

Generate `SESSION_SECRET` and `ENCRYPTION_KEY` as described in `TASKS.md`
(Phase 1, step 3). Then set the connection URLs for your own servers. Pick any
role name and password, but the test database name **must end in `_test`**:

```
DATABASE_URL=postgres://actualpay:<password>@localhost:5432/actualpay_dev
TEST_DATABASE_URL=postgres://actualpay:<password>@localhost:5432/actualpay_test
REDIS_URL=                # empty = in-process rate limits; or redis://:<password>@localhost:6379
TEST_REDIS_URL=           # optional; see below
```

URL-encode special characters in passwords (`@` becomes `%40`).

Without `TEST_REDIS_URL`, the two integration tests that check counters shared
between instances are skipped; everything else, including in-process rate
limiting, still runs. If you set it (for example
`redis://:<password>@localhost:6379/15`), the tests **flush** that logical
database and refuse to run unless it is database `/15`. Do not point it at a
Redis whose database 15 holds anything you need.

## 3. Create the role and databases

This replaces the Docker init script. It creates the role from `DATABASE_URL`
and both databases, and is safe to run more than once. Give it a PostgreSQL
superuser through `ADMIN_DATABASE_URL`; it is used only for this command.

```bash
# bash
ADMIN_DATABASE_URL=postgres://postgres:<superuser password>@localhost:5432/postgres \
  npm run db:setup-native
```

```powershell
# PowerShell
$env:ADMIN_DATABASE_URL = 'postgres://postgres:<superuser password>@localhost:5432/postgres'
npm run db:setup-native
Remove-Item Env:ADMIN_DATABASE_URL
```

If you would rather do it by hand, run the equivalent in `psql` as a superuser:

```sql
CREATE ROLE actualpay LOGIN PASSWORD '<password>';
CREATE DATABASE actualpay_dev OWNER actualpay;
CREATE DATABASE actualpay_test OWNER actualpay;
```

## 4. Continue as usual

```bash
npm run db:migrate
npm run verify
```

Skip the `docker compose` lines in `TASKS.md` (the Docker prerequisites, the
`docker compose up/ps/exec` steps, and `docker compose down`). Where a step
uses `docker compose exec postgres psql ...`, run `psql` against the same
database yourself, for example
`psql postgres://actualpay:<password>@localhost:5432/actualpay_dev`.
The Redis outage check in Phase 2 section 7 only applies if you run a Redis
server; with `REDIS_URL` empty, `/health/ready` should show
`"redis":"not_configured"` instead.
