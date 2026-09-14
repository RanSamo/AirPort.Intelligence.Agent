# Airport Investment Intelligence Agent

An AI agent that helps analysts find **US airports where modernization capital is most likely to pay off**, using public aviation data from the Bureau of Transportation Statistics and the FAA.

Ask it questions in plain English — by typing or by voice — and it answers with real figures, explains how it reached them, and tells you where it is uncertain.

```
> Which airports in New England are strong candidates for terminal expansion?

  [tool] rank_airports          regionId=new_england profile=terminal
  [tool] test_score_sensitivity regionId=new_england

  Boston Logan leads at 72.4, the 83rd percentile of large hubs, and holds
  first place in 90% of plausible weightings. Bangor, Portland and T.F. Green
  are statistically tied behind it — they swap places in roughly half of
  weightings, so I would not read anything into the order.
```

---

## What makes it different

**Every number comes from code, not from the model.** The language model decides *which* analysis to run and how to phrase the answer. Scores, rankings and exclusions are produced by a deterministic engine covered by 100 tests. Ask the same question twice and the numbers are identical — you can even run the ranking with **no LLM involved at all** via `npm run rank`.

**It shows its working.** Every tool call appears live in the interface as the answer is composed, so you can watch the analysis happen rather than trusting the prose.

**It explains scores term by term.** Each score decomposes into contributions that sum *exactly* to the total — no hand-waving about "strong fundamentals".

**It knows when it is guessing.** A Monte Carlo simulation over the scoring weights reports whether a ranking is robust or an artefact of how the model was tuned. When two airports are statistically tied, it says so instead of presenting a meaningless order.

**It refuses to invent data.** Metrics with no public source were removed rather than estimated. Airports lacking data are excluded with a specific reason — *"not covered by BTS On-Time Performance reporting, so its capacity pressure cannot be assessed"* — never a vague "insufficient data".

**It asks instead of assuming.** "LA" means five different airports; the agent lists them and asks which you meant.

---

## Requirements

- **Node.js 22 or newer** (`node --version`) — Node 20 reached end-of-life in April 2026
- An **Anthropic API key** — only for the chat agent; the scoring engine and all tests run without one

No database to install, and **no data ingest required** — the built data snapshot is committed to the repository.

---

## Setup

```bash
# 1. Install dependencies (backend, then the web UI)
npm install
npm run web:install

# 2. Create your environment file
cp .env.example .env        # Windows: copy .env.example .env
```

Then open `.env` and add your key:

```ini
# Required for the chat agent. Get one at https://console.anthropic.com/
ANTHROPIC_API_KEY=sk-ant-...

# Optional. Adds a live-flight-activity tool. Everything works without it.
OPENSKY_CLIENT_ID=
OPENSKY_CLIENT_SECRET=
```

> **Check the install without spending anything:** run `npm run rank`. It produces a full national ranking using only local data — no API key, no network. If that works, everything is wired up correctly.

<details>
<summary><strong>Troubleshooting</strong></summary>

**`sh: tsx: command not found` or `sh: concurrently: command not found`**
Dependencies were not installed at the repository root. Run `npm install` there — not inside `web/`.

**`Cannot find module` for a React or Vite package**
The web interface has its own dependencies. Run `npm run web:install`.

**`ANTHROPIC_API_KEY is not set`**
Create `.env` from `.env.example` and add your key. Only the chat agent needs it — `npm run rank`, `npm test` and `npm run verify:all` all work without one.

**Port already in use**
The API uses 3001 and the UI 5173. Override the API port with `PORT=3002 npm run server`.

**`npm install` fails compiling `better-sqlite3`**
You are on Node 20 or older. `better-sqlite3` ships prebuilt binaries only for supported Node versions, and falls back to compiling from source against V8 APIs that have since changed. Upgrade to Node 22 or newer — npm deletes `node_modules` entirely when a package fails to build, so the failure can look like nothing installed at all.

</details>

---

## Running it

### Web interface (recommended)

```bash
npm run dev
```

Starts the API on **:3001** and the UI on **:5173**. Open <http://localhost:5173>.

You get the conversation, a live agent trace showing each tool call, and a panel with data vintages, the scoring configuration and the system's stated limitations.

**Voice** is built in — click the microphone to ask a question aloud, or toggle *Speak replies* to have answers read back. It uses the browser's built-in speech engine, so there is no extra key or cost. Speech recognition needs **Chrome or Edge**; everything else works in any browser.

### Command line

```bash
npm run chat                              # interactive
npm run chat -- "Your question here"      # one-shot
```

Same agent, no build step.

### Deterministic ranking — no LLM

```bash
npm run rank                                            # national
npm run rank -- --region new_england --profile terminal
npm run rank -- --airports LAX,SNA,BUR --profile airfield
npm run rank -- --region new_england --explain --sensitivity
```

| Flag | Values |
|---|---|
| `--region` / `--state` / `--airports` | `new_england`, `los_angeles`, `CA`, `LAX,SNA` … |
| `--profile` | `terminal` · `airfield` · `balanced` |
| `--aggregation` | `geometric` · `arithmetic` |
| `--scale` | `none` · `moderate` · `strong` |
| `--top` `--explain` `--sensitivity` | result count · score breakdown · robustness test |

---

## Verifying it works

```bash
npm run verify:all
```

Runs the typecheck, 100 unit tests, and four audits that re-check the system's own assumptions — data coverage against the live upstream source, unit consistency, config alignment, and every agent tool end to end. **Takes about a second and costs nothing**, because none of it needs the API.

Individually:

| Command | What it checks |
|---|---|
| `npm test` | 100 unit tests — scoring maths, spill model, normalization, voice text |
| `npm run tools:test` | All 11 agent tools, without the LLM |
| `npm run test:resolution` | Place-name resolution ("LA" must not match Atlanta) |
| `npm run validate:domestic` | Domestic/total unit-mixing audit |
| `npm run validate:config` | Metric registry matches the scoring config |
| `npm run verify:coverage` | Snapshot coverage vs live upstream data |
| `npm run inspect` | Human-readable slice of the snapshot |
| `npm run tools:preview` | Exactly what the model sees when choosing a tool |

---

## Rebuilding the data (optional)

The snapshot is committed, so this is only needed to pull newer months.

```bash
npm run ingest           # ~25 min: downloads and aggregates BTS + FAA data
npm run build:metrics    # <1s: recomputes the 14 metrics
```

Downloads are cached locally, so a re-run is fast. Use `--only` and `--from`/`--to` to narrow the scope.

---

## How it works, briefly

```
 PUBLIC SOURCES          ONE-OFF BUILD            RUNTIME (local, <1 ms)
 ──────────────          ─────────────            ──────────────────────
 BTS T-100      ┐
 BTS On-Time    ├─ ingest ─▶ Airports.db ─▶ metrics ─▶ ScoringEngine
 OurAirports    │            (committed)                     │
 FAA + curated  ┘                              ┌─────────────┴──────────┐
                                               ▼                        ▼
                                        npm run rank          11 tools ─▶ Claude
                                        (no LLM)                        │
                                                                        ▼
                                                               Web UI · CLI
```

Airports are scored on four questions: **is capacity binding today**, **would new capacity get filled**, **is a marginal passenger high-yield**, and **can you actually build and use it**.

> **A note on scope:** no public data exists on airport construction cost, so this ranks *relative expansion opportunity* — not return on investment. The agent states this whenever it matters.

---

## Documentation

- **`CLAUDE.md`** — engineering detail: verified data sources, investigated dead ends, code conventions, decision log

## Project layout

```
src/
  Ingest/        download and aggregate public data
  Metrics/       turn snapshot facts into 14 scored metrics
  Scoring/       the deterministic engine (normalize, score, explain, test)
  Agent/         11 tools, system prompt, conversation handling
  Server/        Fastify API with streaming responses
  Repositories/  data access behind interfaces
  Types/         all shared types, including the DI contracts
web/             React interface with voice support
Tests/           100 unit tests
Data/Snapshot/   the committed data snapshot
```
