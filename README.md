# EES local dashboard

A browser-based dashboard for local development of
[explore-education-statistics](https://github.com/dfe-analytical-services/explore-education-statistics):
starting/stopping services, viewing logs, and managing test data and backups.

## Running

```bash
pnpm install
pnpm dashboard
```

This runs at `http://localhost:4300` by default (override with the `DASHBOARD_PORT` environment variable).

The dashboard manages the services of an explore-education-statistics checkout. By default it looks for a
checkout named `explore-education-statistics` alongside this repository; point it anywhere else by setting
`EES_PROJECT_ROOT` in a `.env` file (see [`.env.example`](.env.example)):

```bash
cp .env.example .env
```

Anything set in the real environment takes precedence over `.env`, so a one-off run against another checkout
is still just:

```bash
EES_PROJECT_ROOT=/path/to/checkout pnpm dashboard
```

Because `EES_PROJECT_ROOT` accepts any checkout, this also works with
[git worktrees](https://git-scm.com/docs/git-worktree): run one dashboard while switching which worktree's
services it manages.

Note that explore-education-statistics' `docker-compose.yml` pins the Compose project name
(`name: explore-education-statistics`), so every checkout shares one container stack regardless of its
directory name. Pointing `EES_PROJECT_ROOT` at a different checkout therefore manages the *same* containers,
not a second set - but the bind-mounted paths (`./data/ees-mssql` and friends) resolve relative to whichever
checkout Compose is invoked from, so switching between them will recreate those containers against the other
checkout's data.

## Command line

The dashboard has its own service definitions and dependency resolution, independent of
explore-education-statistics' `start` script. A command line equivalent of `start` using them is available
too, which additionally starts any services a requested service depends on (e.g. `admin` also starts
`processor`/`publisher`) and resolves `PublicDataDbExists` once across everything it's asked to start:

```bash
pnpm start:dashboard admin
```

## Tests

The dependency resolution has tests, run with:

```bash
pnpm test:scripts
```
