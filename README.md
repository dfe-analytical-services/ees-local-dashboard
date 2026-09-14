# EES local dashboard

A browser-based dashboard for local development of
[explore-education-statistics](https://github.com/dfe-analytical-services/explore-education-statistics):
starting/stopping services, viewing logs, and managing test data and backups.

## User beware

This was entirely vibe coded to make EES developers lives a little easier when managing their local EES environment. There is no guarantee that this is maintained or bug free.

## Running

```bash
cp .env.example .env
# Update .env to point so EES_PROJECT_ROOT is your EES directory
pnpm install
pnpm dashboard
```

This runs at `http://localhost:4300` by default (override with the `DASHBOARD_PORT` environment variable).
