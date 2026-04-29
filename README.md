# Facebook Ad Agent — Claya

Telegram bot that reads a Meta Ads account and (after Phase 1 verification) acts on it through gated, audit-logged write commands. The agent's persona, healthcare benchmarks, and hard guardrails live in `agents/AGENT.md` — that file is loaded as the Claude system prompt on every message.

## Stack

- Node.js + TypeScript (run with `tsx`)
- `node-telegram-bot-api` — Telegram polling
- `axios` — Meta Marketing API (`v21.0`)
- `@anthropic-ai/sdk` — Claude Opus 4.7 with adaptive thinking + prompt caching on `AGENT.md`
- `@supabase/supabase-js` — hourly snapshots (`campaign_snapshots`) + write-action audit log (`agent_actions`)

## File layout

```
agents/
  AGENT.md      # system prompt — edit this to change agent behavior
  meta.ts       # Meta Marketing API client
  sync.ts       # hourly snapshot runner (entry point for the cron)
  bot.ts        # Telegram bot + Claude (entry point for long-running process)
  supabase.ts   # shared Supabase client
supabase/
  schema.sql    # run this in Supabase SQL editor before first start
.github/workflows/
  sync.yml      # hourly cron — runs `npm run sync`
.env            # local secrets (gitignored)
.env.example    # template
Procfile        # for Railway / Heroku-style deployments
```

## Setup

### 1. Install

```bash
npm install
```

### 2. Database

In the Supabase SQL editor, run the contents of `supabase/schema.sql` once.

### 3. Environment

Copy `.env.example` to `.env` and fill it in. Required:

| Var | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic console key |
| `META_ACCESS_TOKEN` | Long-lived system-user token with `ads_management` |
| `META_AD_ACCOUNT` | `act_<id>` — the Claya ad account |
| `TELEGRAM_BOT_TOKEN` | From `@BotFather` |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role — bypasses RLS, keep secret |
| `ANTHROPIC_MODEL` | Defaults to `claude-opus-4-7` |
| `ACCOUNT_TZ` | IANA timezone for the no-write window. Defaults to `America/Los_Angeles` |
| `TELEGRAM_ALLOWED_USERNAMES` | Comma-separated, case-insensitive Telegram username whitelist. Defaults to `joshuatatum,pack87`. Anyone not on the list is silently ignored. |

### 4. Run

```bash
# Bot (long-running)
npm run bot

# Hourly snapshot (one-shot)
npm run sync
```

## Deployment

### Bot — Railway (or any long-running host)

The `Procfile` runs `tsx agents/bot.ts`. Set every `.env` var as a Railway service variable.

### Cron — GitHub Actions

`.github/workflows/sync.yml` runs `npm run sync` hourly. In the repo's Settings → Secrets and variables → Actions, add:

- `META_ACCESS_TOKEN`
- `META_AD_ACCOUNT`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The Anthropic key is **not** needed for the cron — `sync.ts` doesn't call Claude.

## Phase 1 commands (read-only)

- `/report` — yesterday's spend, leads, CPL, CTR, CPM by campaign
- `/status` — live: every campaign, status, today's spend / leads, daily budget
- `/changes` — diff vs. the snapshot from ~24h ago (status, budget, new/removed)

Plain-English questions go to Claude with the live snapshot + `AGENT.md` as system prompt.

## Phase 2 commands (gated writes)

- `/pause <campaign>`
- `/budget <campaign> <new daily budget in dollars>`
- `/boost <campaign> <percent>`

Each opens a confirmation flow. Reply `confirm`, `yes`, `do it`, `kill it`, `stop`, etc. to proceed; anything else (including `no`, `cancel`, `nvm`) cancels.

Hard rules enforced in code (mirroring `AGENT.md`):

- ±50% budget cap per single action
- $5 daily floor, $500 daily ceiling per single action
- No writes 02:00–06:00 in `ACCOUNT_TZ` unless the reply contains the word `OVERRIDE`
- Every write writes a row to `agent_actions` first; if the audit insert fails, the Meta call does not happen
- Telegram access is whitelisted by username via `TELEGRAM_ALLOWED_USERNAMES` (comma-separated, case-insensitive). Default: `joshuatatum,pack87`. Anyone else is silently ignored — the bot doesn't reply, log line goes to stderr only.

## Editing agent behavior

`agents/AGENT.md` is loaded once at process start and cached in the Claude prompt cache. After editing it, restart the bot. The healthcare benchmarks, diagnostic framework, and tone rules all live there.

## Security notes

- `.env` is gitignored — keep it that way.
- The Supabase service-role key bypasses RLS. Don't leak it.
- The Telegram bot is whitelisted to `TELEGRAM_ALLOWED_USERNAMES`. To add or remove people, edit that env var and restart the bot — no code change needed. If a whitelisted user changes their Telegram username, update the env var.
- After first deploy: rotate the tokens that have ever been pasted into chat or stored in this repo.
