# OpenSea Mint Sniper

A Telegram bot that watches Ethereum for new and upcoming NFT mints, scores them like a
trading screener, and pings you only when something clears your filter.

**It is alert-only.** It holds no wallet, no private key, and no seed phrase. It cannot spend
your money, because it has no way to. If you later want auto-minting, that is a separate
conversation with a very different risk profile.

Runs for **$0/month** on GitHub Actions.

---

## What you actually get

Three independent signals, all from the official OpenSea API:

| Signal | What it catches | Timing |
|---|---|---|
| **Upcoming drops** | Scheduled mints before they open | **Hours of advance warning** |
| **Live mints** | Collections minting right now | Within ~5 min |
| **New collections** | Projects registered on OpenSea before they have volume | Within ~5 min |

The upcoming-drops signal is the valuable one, and it is what makes free hosting work. It
reads the mint's scheduled start time, so you get told hours ahead — which means it does not
matter that GitHub's free cron is imprecise.

### A sample alert

Real output from the shipped config, not a mockup:

```
⏳ UPCOMING MINT — starts in 2h 58m

Example Genesis Pass
ethereum · 5000 supply · public_sale

Score 77/100  ▰▰▰▰▰▰▰▰▱▱

💰 Mint: 0.0290 ETH
🎫 Max 2 per wallet
🕐 Opens Sat, 22 Aug 2026 14:58:12 GMT

Why this scored what it did
• OpenSea status: approved
• Socials: twitter, discord

Scored on 3/6 signals — thin data, score discounted accordingly

OpenSea · Contract · X · Discord
0x1234567890abcdef1234567890abcdef12345678

Not financial advice. Verify the contract yourself before spending — this bot
checks metrics, not honesty.
```

Every alert shows **why** it scored what it did. That is deliberate: you came from forex, so
you should be able to calibrate this filter against real outcomes instead of trusting a
number. Log which alerts actually went up, then tune `config.json`.

---

## Setup — GitHub Actions ($0)

About 10 minutes. No credit card, no server, no Docker.

### 1. Create your Telegram bot

1. Open Telegram and message **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot`, pick a name and a username ending in `bot`.
3. He replies with a token like `8123456789:AAH_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. **Save it.**
4. Message **[@userinfobot](https://t.me/userinfobot)**. It replies with your numeric `Id`.
   **Save that too** — that is your chat ID.
5. **Send your new bot any message** (just `hi`). Telegram blocks bots from messaging people
   who have never messaged them first. Skip this and your alerts silently never arrive.

### 2. Put the code on GitHub

Create a **public** repository and upload these files (drag-and-drop into GitHub's web
uploader works fine).

> **Why public?** Actions minutes are unlimited on public repos. On a private repo the free
> tier gives 2,000 minutes/month, and this schedule needs about 8,600 runs/month — you would
> run out in the first few days. Your secrets stay encrypted either way; see
> [Security](#security) below.

### 3. Add your secrets

In your repo: **Settings → Secrets and variables → Actions → New repository secret**.

| Name | Value | Required |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | The token from BotFather | Yes |
| `TELEGRAM_CHAT_ID` | Your numeric ID from @userinfobot | Yes |
| `OPENSEA_API_KEY` | A key from opensea.io → Settings → Developer | **Yes, on Actions** |

The bot *can* mint itself a free key at runtime, and that works fine on your own machine. It
does **not** work on GitHub Actions: `POST /api/v2/auth/keys` is rate-limited per IP address,
CI runners share their IPs with an enormous number of other users, and the quota is normally
already spent by a stranger before your job starts. You get `HTTP 429`, the run goes green, and
it screens nothing. Set the secret. See [API keys](#api-keys).

### 4. Turn it on

1. Go to the **Actions** tab and enable workflows if GitHub asks.
2. Pick **Mint sniper** → **Run workflow**. Tick **dry run** for the first go.
3. Watch the log. You should see collections being fetched and scored, and any that would
   have alerted printed in full — with nothing sent to Telegram.
4. Happy? **Run workflow** again with dry run **unticked**. From then on it runs every 5
   minutes on its own.

To check your Telegram wiring specifically, run this locally instead (see [Local](#running-locally)):

```bash
npm run test:telegram
```

---

## Controlling it from Telegram

| Command | What it does |
|---|---|
| `/status` | Current threshold, pause state, counters |
| `/threshold 80` | Only alert at or above this score |
| `/pause` | Stop alerting, keep watching |
| `/resume` | Start alerting again |
| `/recent` | The last few alerts |
| `/help` | The list above |

**Commands take up to 5 minutes to apply.** In poll mode there is no process listening when
you type — each scheduled run reads your messages, acts on them, and saves its place. That
latency is the price of $0 hosting. Always-on mode responds immediately.

Only your chat ID is obeyed. If someone else finds your bot, their commands are ignored and
logged.

---

## Tuning the screener

Edit **`config.json`** directly on github.com — commit it and the next run picks it up. Every
setting has a `_comment` next to it explaining what it does.

The one you will touch most:

```json
"minScore": 70
```

Getting too many alerts? Raise it. Too few? Lower it. `/threshold` does the same thing
temporarily, without a commit.

### How scoring works

Two stages, like screening a currency pair.

**Stage 1 — hard rejects.** Cheap binary disqualifiers, checked first: no contract address,
disabled or NSFW-flagged by OpenSea, a free mint with a huge supply (spam airdrop), a price
above your ceiling, a mint that already started, a collection older than your window.

**Stage 2 — a weighted score out of 100.**

| Component | Weight | Why |
|---|---|---|
| Unique minters ÷ total mints | 30 | The best cheap wash-mint tell. Near 1.0 means many separate wallets wanted in; near 0 means one entity minting to itself to fake demand. |
| Mint velocity vs supply | 20 | Projected sellout speed. |
| Contract age at detection | 15 | Earlier is better. |
| Verified badge / socials | 15 | A proxy for a real team. Weighted modestly on purpose — genuinely new projects have not had time to be verified, and filtering hard on this would remove exactly the early entries you want. |
| Mint price sanity | 10 | Both extremes are warnings. |
| Holder concentration | 10 | Rug proxy: can a few wallets dump on you? |

Then two multipliers are applied, and both exist because the additive score alone got real
cases wrong:

**Confidence.** Not every signal is available for every candidate — an upcoming drop has no
mint velocity yet, and poll mode has no unique-minter count because that needs real-time
transfer watching. Weights are renormalised over what is actually present, so `minScore: 70`
means the same thing however you host it. But renormalising *alone* is perverse: drop a
component that was scoring badly and the average of what remains goes **up**. In testing, a
poll-mode candidate scored 96 while the identical collection with full data scored 85 —
ignorance was outscoring quality. So the score is discounted by how much of the weight was
actually observed, and thin-data alerts say so on the card.

**Risk.** Some findings are not "slightly worse on average", they are reasons to walk away.
As a 10%-weight component, one wallet holding 55% of supply moved a candidate from 85 to 75
— still above threshold, still alerted. Those findings now **multiply** the score instead, so
they can genuinely veto:

| Finding | Multiplier |
|---|---|
| One wallet holds ≥50% of supply | ×0.45 |
| One wallet holds ≥30% | ×0.7 |
| Free mint claimed faster than 30/min (bot farming) | ×0.75 |
| ≥0.5 ETH mint from an unverified collection | ×0.7 |

They compound, and each one prints itself on the alert under **⚠️ Risk flags**. All of it is
tunable in the `risk` block of `config.json`.

To show that working — this collection looks genuinely strong on five of six signals (612
distinct wallets across 700 mints, selling out in an hour, verified socials) and the screener
still kills it, because one wallet holds 31% of the supply:

```
🔴 MINTING NOW

Reservoir Runners
ethereum · 4444 supply

Score 58/100  ▰▰▰▰▰▰▱▱▱▱          ← 83 before the ×0.70 risk multiplier

💰 Mint: 0.0240 ETH
📈 58.0 mints/min · 612 wallets

⚠️ Risk flags
• largest wallet holds 31% of supply

Why this scored what it did
• Healthy spread: 612 wallets across 700 mints (87%)
• Minting 58.0/min of 4444 — sells out in ~1h at this pace
• Created 1h ago
• OpenSea status: approved
• Socials: twitter, discord, website
• Concentrated ownership: top 4 wallets hold 38% (largest 31%)

Scored on 6/6 signals
```

At `minScore: 70` you would never see that message. It is shown here so you know what the
filter is doing on your behalf — and so you can decide you disagree and relax
`risk.highTopHolderPenalty`.

Here is where the shipped defaults land on synthetic scenarios — 7 of 15 alert:

```
 87  ALERT   [6/6]  ideal: verified, spread, fast
 74  ALERT   [6/6]  strong but anonymous (no socials/badge)
 55  filter  [6/6]  wash-minted (3 wallets / 400 mints)
 34  filter  [6/6] risk x0.45  whale-held (top wallet 55%)
 54  filter  [6/6] risk x0.70  moderate whale (top wallet 33%)
 78  ALERT   [6/6]  slow mint (2/min of 5000)
 68  filter  [6/6] risk x0.75  free mint, small supply, fast
 86  ALERT   [6/6]  free mint, small supply, organic pace
 75  ALERT   [6/6]  overpriced 1.5 ETH, approved
 45  filter  [6/6] risk x0.70  overpriced 1.5 ETH, unverified
 84  ALERT   [4/6] conf x0.88  poll mode: no velocity/minter data
 63  filter  [4/6] conf x0.88  poll mode + anonymous
 81  ALERT   [3/6] conf x0.85  upcoming drop (pre-mint, no holders)
 56  filter  [3/6] conf x0.85  upcoming drop, anonymous
 18  filter  [6/6] risk x0.70  worst realistic: anon, slow, concentrated
```

Expect roughly **3–10 alerts/day** at `minScore: 70`, but that depends entirely on how busy
the market is. Watch it for a couple of days before deciding it is wrong.

---

## Honest limits of the free path

Read this part. It is the difference between the bot working the way you expect and you being
annoyed at it in a week.

- **5-minute floor, and GitHub is not punctual.** Scheduled runs are delayed or silently
  dropped under load. The cron deliberately avoids `:00`/`:15`/`:30`/`:45` for this reason,
  but there is no SLA. Advance warnings absorb the slop; **a stealth mint that sells out in
  90 seconds will be missed.** If that matters to you, you need always-on mode.
- **No true real-time.** Live-mint detection in poll mode sees a mint after the fact.
- **Public repo means your `bot-state` branch is readable.** It holds only dedupe keys, a
  Telegram message cursor, and counters — no credentials, and there is a test asserting that.
- **Free OpenSea keys cannot be minted from CI.** That endpoint is rate-limited per IP and
  GitHub's runner IPs are shared, so on Actions you must set `OPENSEA_API_KEY`. See below.
- **Public-repo schedules get auto-disabled after 60 days of inactivity.** A monthly keepalive
  workflow is included. If GitHub emails you anyway, open Actions and click *Enable workflow*.
- **This screens metrics, not honesty.** A high score means the on-chain shape looks healthy.
  It cannot tell you the team will not vanish. Nothing automated can.

---

## API keys

**On GitHub Actions you need a real key.** Set the `OPENSEA_API_KEY` secret to one from
**opensea.io → Settings → Developer**. It is the only thing the bot cannot arrange for itself.

Why the auto-minting fallback does not save you here: `POST /api/v2/auth/keys` hands out a free
key with no signup, but it is rate-limited **per IP address**. GitHub's runners come from a
shared pool, so by the time your job starts the quota for that IP has usually been spent by
somebody else's job. You get `HTTP 429`. Waiting will not help and neither will a slower cron —
it was never your quota to begin with. When this happens the run still exits 0 (a failure every
5 minutes would bury your inbox), so it reports itself as a **red annotation** on the run
instead: *"Mint sniper: no OpenSea API key"*.

Auto-minting is still genuinely useful on your own machine — one IP, your quota — which is why
`npm run dry` works with nothing configured. Those keys **expire after about 7 days**, and each
run mints a fresh one, so it is a convenience for testing rather than a way to run in
production.

Either kind of key is rate-limited to roughly 600 reads/hour. The request budget in
`config.json` (`budget.maxRequestsPerRun: 40`) is set so 12 runs/hour stays under that ceiling.
Raise the cron interval before raising that number.

### If that Developer page is gated

If opensea.io does not just hand you a key — some accounts see an application form — say so and
we will point the collectors at a public indexer such as Reservoir, which needs no key. The
detection and scoring layers do not care where the collection data comes from.

---

## Running locally

Node 18.17+ and **no dependencies to install** — there is no `npm install` step.

```bash
cp .env.example .env
```

Fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, then:

```bash
npm run selftest
```

166 offline checks covering scoring, wash-mint detection, HTML escaping, and state handling.
No network, no key, no Telegram needed — run this first.

```bash
npm run dry
```

One full cycle against the live API. Scores everything, prints what it would send, sends
nothing. This is the command that proves your API access works.

```bash
npm run test:telegram   # send one sample card, to check wiring and formatting
npm run once            # one real cycle, end to end
```

`.env` is gitignored. Never commit it.

---

## Always-on mode (optional, ~$5/mo)

Real-time instead of 5-minute polling. Catches a mint the second the first token is minted, by
watching OpenSea's event stream and treating any transfer *from the zero address* as a mint.
GitHub Actions cannot host this — its jobs are short-lived by design.

```bash
docker build -t mint-sniper .
docker run -d --restart=unless-stopped --env-file .env \
  -v mint-sniper-state:/state mint-sniper
```

Or without Docker:

```bash
MODE=stream npm start
```

Stream mode needs a global `WebSocket`, which means **Node 22+**. On Node 18 or 20 it falls
back to the `ws` package if you have it installed, and otherwise tells you to use poll mode.
The Dockerfile uses Node 22 so it stays dependency-free.

---

## Security

- **No wallet, no keys, no seed phrase.** The bot cannot transact. This is the single most
  important property and it is worth keeping.
- Secrets live in **GitHub Secrets**, encrypted, and stay private even on a public repo. They
  are never written to `state.json`.
- The committed state file is asserted secret-free by the self-test, using an allowlist of
  permitted fields — so adding a new field fails CI until someone has reviewed it.
- Telegram commands are only obeyed from your chat ID.
- Collection names from the API are HTML-escaped before being sent to Telegram. There is a
  test for this using a hostile name, because a collection called `<script>` should not be
  able to garble your alerts.
- **If anyone offers you an "NFT sniper framework" that wants your seed phrase or private key,
  it is a wallet drainer.** There is no legitimate reason for a sniper tool to hold your keys
  to *alert* you about anything.

---

## Project layout

```
├─ .github/workflows/
│  ├─ poll.yml           # the $0 cron runner; commits state to a bot-state branch
│  ├─ selftest.yml       # runs on push, catches a broken config.json edit
│  └─ keepalive.yml      # monthly commit so the schedule is not auto-disabled
├─ src/
│  ├─ index.js           # entry; dispatches poll | stream | test | new-key
│  ├─ config.js          # config.json + .env + Telegram overrides, validated
│  ├─ opensea.js         # REST client: key rotation, budget, 429 backoff, cache
│  ├─ sources.js         # the three detection signals; list → filter → enrich
│  ├─ score.js           # the screener (pure function, no network, no clock)
│  ├─ mints.js           # zero-address transfer = mint; rolling velocity windows
│  ├─ telegram.js        # alert cards + getUpdates command handling
│  ├─ poll.js            # one scheduled cycle
│  ├─ stream.js          # always-on websocket mode
│  ├─ state.js           # dedupe, cursor, counters — the file that gets committed
│  └─ util.js            # formatting and math helpers
├─ test/selftest.js      # 166 offline checks
├─ config.json           # your screener — edit this on github.com
├─ Dockerfile            # always-on mode
└─ .env.example
```

**Zero runtime dependencies.** Nothing to install, no build step, no supply-chain surface, and
you can edit any of it in GitHub's web editor and have it live in five minutes.

---

## Not in v1

Say the word and we can add any of these:

- **Auto-minting.** Needs a wallet, which changes the risk profile completely. Worth doing
  only once you trust the signal quality.
- **Multi-chain** (Base, Solana). The collector layer is already written chain-agnostic.
- **X/Twitter sentiment** as a scoring input.
- **Secondary-market flip alerts** — floor-price moves on things you were alerted about.
- **Backtesting.** The piece I would actually push for next: log every scored alert, check
  the floor price 24h and 7d later, and find out empirically which components predict
  anything. It is the only way to turn this from a plausible filter into a validated one —
  and it is the same discipline you would apply to a forex strategy.

---

*Not financial advice. NFT mints are overwhelmingly unprofitable. This is a filtering tool,
not an edge.*
