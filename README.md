![OpenUptime](apps/web/public/og.png)

# OpenUptime

Open-source uptime monitoring and status pages. Runs in one Docker container (or a Node process) against MySQL 8.

[Hosted version](https://openuptime.app) · [Docs](https://openuptime.app/docs/self-host) · [Reference](docs/reference.md) · [MIT license](LICENSE)

## Features

**Monitoring**

- [x] HTTP / HTTPS with keyword matching and slow-response alerts
- [x] TCP, DNS and [WebSocket](https://openuptime.app/docs/websocket)
- [x] Heartbeat (push) monitors for cron jobs and background workers
- [x] PostgreSQL, MySQL and Redis
- [x] Domain expiry
- [x] EVM and Solana RPC node health
- [x] [MCP server](https://openuptime.app/docs/mcp-monitors) checks
- [x] [Multi-region checks](https://openuptime.app/docs/regions), with your own probes
- [x] Monitor dependencies, so a downstream outage doesn't page you twice

**Incidents and status pages**

- [x] Incidents with acknowledgement, assignment and postmortems
- [x] Maintenance windows, one-off or recurring
- [x] Public status pages
- [x] Email and RSS subscriptions for status page visitors
- [x] [Status badges and embeds](https://openuptime.app/docs/embed) for your site or README

**Alerts**

- [x] Slack, Discord, Microsoft Teams, Telegram, Lark / Feishu, ntfy, Bark and Apprise
- [x] PagerDuty, webhooks and email
- [x] Push notifications to the [iOS app](https://openuptime.app/ios)
- [x] Repeat reminders and escalation

**Teams and automation**

- [x] Workspaces, projects and roles
- [x] GitHub sign-in and two-factor authentication
- [x] [REST API](https://openuptime.app/docs/api) with API keys
- [x] [MCP server](https://openuptime.app/docs/mcp) so your AI agent can manage monitors, incidents and status pages
- [x] JSON import / export

| Part | Stack |
|---|---|
| `apps/api` | Hono, better-auth, Node/Docker entry point (cron + in-process check queue) |
| `apps/web` | Astro (static pages, SSR for status pages) + React islands |
| `packages/repo` | Storage interface (`Repo`) and entity types |
| `packages/db-pg` | MySQL implementation of `Repo`: Drizzle schema, migrations |

## Self-host with Docker

One container runs the API, the web app and the check scheduler; MySQL comes with the compose file. Either run the
published image or build it from source; the settings are the same.

### Option A: run the published image

Tagged releases are published to `ghcr.io/becoolme/openuptime` for `linux/amd64` and `linux/arm64`. You need no clone and
no build:

```bash
mkdir openuptime && cd openuptime
curl -fsSLO https://raw.githubusercontent.com/becoolme/openuptime/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/becoolme/openuptime/main/.env.docker.example -o .env
```

Edit `.env`: set `MYSQL_PASSWORD` and `BETTER_AUTH_SECRET` (`openssl rand -hex 32`), and uncomment `OPENUPTIME_IMAGE`.
Pin a version (`ghcr.io/becoolme/openuptime:0.1.0`) or follow the newest release (`:latest`). Then:

```bash
docker compose pull && docker compose up -d     # http://localhost:8080
```

Upgrade: change the tag if you pinned one, then run the same two commands again. Migrations run on start.

### Option B: build from source

```bash
git clone https://github.com/becoolme/openuptime.git && cd openuptime
cp .env.docker.example .env      # set MYSQL_PASSWORD and BETTER_AUTH_SECRET (openssl rand -hex 32)
docker compose up -d --build     # http://localhost:8080
```

Upgrade: `git pull`, then `docker compose up -d --build`.

### Either way

The schema is migrated on start and the data lives in the `mysqldata` volume. Set `PUBLIC_URL` when the app is not served
from `http://localhost:8080`. Email is optional; see [Reference](docs/reference.md#email).

Once your own account exists, set `DISABLE_SIGNUP=true` in `.env` and run `docker compose up -d` to close registration
(invited people can still join).

## Develop

```bash
pnpm install
cp .env.example apps/api/.dev.vars   # edit DATABASE_URL and secrets
DATABASE_URL=mysql://user:pass@localhost:3306/openuptime_dev pnpm db:migrate   # same URL as in .dev.vars
pnpm dev:api    # http://localhost:8787  (checks run inline every 15s)
pnpm dev:web    # http://localhost:4321  (proxies /api to the API)
pnpm typecheck
```

## MCP server

Agents (Claude, Cursor, Codex and any MCP client) can manage monitors, incidents and status pages over Streamable HTTP at
`/api/mcp`, authorizing with OAuth or an API key:

```bash
claude mcp add --transport http openuptime https://openuptime.app/api/mcp   # or https://<your-host>/api/mcp
```

Client setup, scopes and the tool list are in the [MCP docs](https://openuptime.app/docs/mcp).
An agent skill that teaches the common workflows ships in [skills/openuptime](skills/openuptime):
`npx skills add becoolme/openuptime`.
 The hosted server is listed
in the [MCP Registry](https://registry.modelcontextprotocol.io) as `app.openuptime/mcp`; [server.json](server.json) is its entry.

Tests, how checks run, the MCP server, alert channels and the other details are in [docs/reference.md](docs/reference.md).

## Open source vs hosted

The monitoring itself is the same code in both. The hosted service at [openuptime.app](https://openuptime.app) adds
plans, billing and a few features that live only in that build; it plugs into this repo through one interface
(`Edition`, see [docs/editions.md](docs/editions.md)), so nothing in the core is locked or throttled.

| | Self-hosted (this repo, MIT) | Hosted ([openuptime.app](https://openuptime.app)) |
|---|---|---|
| Monitors, incidents, status pages, alert channels, API, MCP | All of it | All of it |
| Limits | None: no plans, quotas or metering | Free plan, paid plans from $5/month ([pricing](https://openuptime.app/pricing)); monitors, checks, emails and history length depend on the plan |
| Running it | You: MySQL, the container, a mail provider, backups, upgrades | We do; nothing to install |
| SSL certificate monitoring (expiry alerts, `ssl` monitor type) | Not included | Lite and above |
| Custom domain for a status page | Not included | Every paid plan (Lite and above), plus early-access workspaces |
| Where your data lives | Your database | Ours (MySQL on managed hosting) |

Pick self-hosting if you want to own the data and the infrastructure, or have no limits to worry about. Pick hosted if
you would rather not run anything. Both receive the same core updates.

## Contributing & security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## License

[MIT](LICENSE)
