# Design & Architecture

**Airport Investment Intelligence Agent** — ranks US airports by expansion opportunity from public aviation data.

---

## 1. The framing decision

The brief asks where renovations will be *most profitable*. **No public data exists on airport construction cost**, so ROI and IRR cannot be computed, and pretending otherwise would be the worst thing this system could do.

What it computes instead is **relative expansion opportunity**, on one thesis:

> You make money relieving a **binding constraint** on demand that **already exists and is growing**, at an airport where a marginal passenger is **high-yield**, and where nothing structural blocks **realization**.

Those four clauses are the four pillars of the score. Everything else follows from them.

---

## 2. Data flow

```
 PUBLIC SOURCES            ONE-OFF BUILD (~25 min)         RUNTIME (local, <1 ms)
 ──────────────            ───────────────────────         ──────────────────────

 BTS T-100      ┐
 BTS On-Time    ├─ ingest ─▶  Airports.db  ─ metrics ─▶  metric_values
 OurAirports    │             9.6 MB                          │
 FAA + curated  ┘             committed to git                ▼
                                                        ScoringEngine
      6.6 GB streamed,                              (+ sensitivity, relief,
      9.6 MB persisted                                 spill, waterfall)
                                                              │
                                        ┌─────────────────────┴──────────────┐
                                        ▼                                    ▼
                                  npm run rank                     11 tools ──▶ Claude
                                  (no LLM at all)                             │
                                                                              ▼
                                                                    Web UI  ·  CLI
```

**The snapshot is the boundary.** Above it: slow, networked, offline. Below it: fast, local, deterministic. A chat request makes **zero network calls** for anything that feeds a number — the only request-time fetch is live FAA status, which never touches a score.

Data volume affects *build* time, never *query* time. OTP arrives as 275 MB/month and is streamed row-by-row into counters; individual flights are never stored.

### Why a snapshot rather than live queries

I chose to ingest once for network and performance reasons. BTS publishes monthly and the data carries a roughly three-month lag, so a live fetch would return exactly the same numbers — slower, and with a network dependency on every question. On-Time Performance has no query API at all; it is a 31 MB ZIP per month. There is nothing to gain from calling it at request time.

Reading locally instead makes queries sub-millisecond, removes rate limits and upstream outages from the request path, and keeps results reproducible — which the tests and the sensitivity analysis both depend on.

In production I would add a monthly cron to append each new month as it is published. The ingest is already idempotent and re-runnable, and the snapshot's `dataVersion` is part of every cache key, so a refresh invalidates stale scores automatically.

> **Live data still has a place.** FAA operational status is fetched at request time, because *that* genuinely changes by the hour. It never feeds a score.

---

## 3. Scoring methodology

### The whole model in one line

```
Score  =  ( Need^0.65  ×  Payoff^0.35 )  ×  Feasibility  ×  Materiality

Need   =  0.55 × Constraint  +  0.45 × Latent Demand
Payoff =  Monetization
```

### The four questions

| Pillar | Plain English | Example metrics |
|---|---|---|
| **Constraint** | Is capacity binding *today*? | taxi-out times, delay rate, **system-cause delay share**, peak-hour passengers |
| **Latent demand** | Would new capacity get *filled*? | 3-yr growth, load factor, spill rate |
| **Monetization** | Is a marginal passenger *worth much*? | international share, long-haul share, average trip length |
| **Feasibility** | Can you actually *build and use* it? | slot control, perimeter rules, land constraints |

14 metrics total — 12 measured, 2 modeled, none dependent on hand-curated data.

**The sharpest single metric is `nas_delay_share`**: the share of delay minutes caused by the air-traffic system rather than weather. It separates congestion that capital can fix from congestion it cannot. An airport delayed by snow is not an investment; one delayed by its own saturation is.

### Four design choices that matter

**① Normalize within peer group, then correct for size.**
Metrics are normalized within each airport's FAA hub class, using median/MAD rather than mean/stdev (aviation data is heavily skewed — a few mega-hubs would drag any mean). This makes a Small hub comparable to a Large one.

The side effect bit us on the first real run: Bangor (250k passengers) outranked Boston Logan (21M) because it was *top of its cohort*. Cohort scores measure **intensity**, not the size of the prize. A **materiality multiplier** — log-scaled on passenger volume — corrects it. Logarithmic on purpose: linear weighting would collapse the ranking into a passenger-count league table.

**② Geometric, not additive, across Need and Payoff.**

| | Need | Payoff | Arithmetic | Geometric |
|---|---|---|---|---|
| Airport A | 90 | 20 | **65.5** ← wins | 53.2 |
| Airport B | 55 | 55 | 55.0 | **55.0** ← wins |

A is congested with nothing to monetize. Arithmetic lets one pillar compensate for a dead one; geometric requires both halves of the thesis to hold.

It is a judgement call rather than a fact, so it is **switchable three ways**:

| Where | How |
|---|---|
| **In conversation** | *"Re-rank that using arithmetic."* `rank_airports`, `explain_score` and `test_score_sensitivity` all take an `aggregation` parameter, so the model passes it straight through to the engine |
| **CLI** | `npm run rank -- --aggregation arithmetic` |
| **Config** | `src/Config/ScoringConfig.json` → `"aggregation"`, which changes the default |

Deliberately *not* a toggle in the web UI. Asking the agent to re-rank and watching the order shift demonstrates that the model is driving real engine parameters, which a dropdown would hide. The tool description instructs it to change the mode only when asked, so it never switches on its own.

**③ Never impute. Ever.**
A missing metric is dropped and the pillar's weights renormalize over what remains; coverage falls and is reported. Airports below a coverage threshold are excluded from rankings with a **specific, question-aware reason** — never "insufficient data":

> *"Tweed New Haven is not covered by BTS On-Time Performance reporting, which only includes carriers above 0.5% of US domestic revenue. Without it there are no delay, taxi-time or peak-hour figures, so its capacity pressure cannot be assessed for a terminal expansion comparison."*

Several designed metrics were **deleted** rather than faked when no data source existed — gate counts (no public API anywhere), runway capacity, and three catchment-demographic metrics. A permanently-absent metric is worse than no metric.

**④ Explanations sum exactly.**
Every score decomposes into terms that add to the total by construction — a real attribution, not an approximation:

```
  50.0   Peer-group median
 +12.4   Capacity pressure       driven by taxi-out and system-cause share
  +8.1   Demand growth           driven by spill rate and load factor
  −3.2   Revenue quality
  −0.6   Balance across pillars  penalised for being uneven (geometric)
  +7.1   Materiality (×1.11)     21.1M annual passengers
 ─────
  73.8
```

### Are the rankings real, or did we manufacture them?

The weights are judgement calls, so `SensitivityAnalyzer` runs a **Monte Carlo simulation over them**: 400 draws, each resampling every weight in the model and re-ranking from scratch. The output is a distribution of ranks per airport rather than a single ordering.

Each weight is multiplied by an independent **log-normal** factor (σ = 0.35, roughly ±40%). Log-normal rather than uniform because it is symmetric *in proportion* — halving a weight is exactly as likely as doubling it, which is the right behaviour for quantities that only matter relative to one another. Two-way splits are renormalized back to 1 after perturbation.

The run is **seeded**, so the same question always returns the same robustness figure. A confidence number that drifted between identical questions would undermine the very thing it exists to establish.

It exists because the first real run produced this:

```
2  BGR  66.5      Three airports within 0.1 points,
3  PWM  66.4      printed as distinct ranks.
4  PVD  66.4
```

They swap places in ~48% of plausible weightings — they are **tied**, and the agent now says so. Boston holds rank 1 in 90% of draws; that one *is* a real finding.

> **Non-obvious:** perturbing only *metric* weights reports false confidence. When every metric in a pillar moves together the pillar score doesn't change at all, so the ranking looks perfectly stable. The **pillar structure** must be perturbed too — it's the assumption a different analyst is most likely to disagree with. Including it moved Boston's stability from a misleading 100% to an honest 90%.

---

## 4. Key tradeoffs

| Decision | Gained | Cost |
|---|---|---|
| **Committed snapshot** over live queries | Sub-ms, reproducible, demo-safe, works offline | Data is as-of a date, not real-time |
| **Deterministic scoring**, LLM narrates only | Same question → same numbers, fully auditable | Rigid; cannot reason beyond its 14 metrics |
| **Geometric** across pillars | Refuses one-dimensional winners | Harder to explain; needs a floor near zero |
| **Cohort normalization** | Fair comparison across airport sizes | Required a materiality multiplier to fix cross-cohort ranking |
| **Delete metrics without data** | No fabrication, no permanent gaps | Lost the demographic dimension entirely |
| **All ~1,090 airports** over a curated top-70 | Answers any US question; no hidden scope limit | Coverage varies wildly and must be disclosed per airport |
| **Web Speech API** for voice | Zero keys, zero cost, nothing to break live | Chrome/Edge only |
| **Dependency injection** | Fully testable without a database | See below — it is not free |

---

## 5. Architecture: dependency injection

Constructor injection with a composition root (`CreateScoringContainer`). No decorators, no `reflect-metadata`, no DI framework — interfaces in `src/Types/Ports/`, implementations in feature folders, wiring in one file.

**Why it earns its place here.** The central risk in this project is a **silent scoring error**: numbers that look plausible and are wrong. DI is what makes that risk testable.

- **The whole pipeline runs without a database.** Tests substitute in-memory repositories through the same ports — 10 end-to-end scoring tests in 46 ms, no mocking library, no fixtures on disk. This is what let 100 tests exist at all, and those tests caught real defects.
- **Strategy choices stay at the edge.** Geometric vs arithmetic is a lookup in `AggregatorFactory`, not an `if` buried inside the maths. That is precisely why the user can switch modes mid-conversation and every code path behaves identically.
- **The system extends without edits.** Adding an ingest source means writing one class; the orchestrator never changes. Four sources were added this way.
- **Swapping infrastructure is contained.** Voice is behind `VoiceProvider`; moving from the Web Speech API to Deepgram is one new implementation and no change to any component.

**The costs, briefly.** Roughly 30% of the codebase is interfaces and wiring that a direct implementation would not need, and the indirection means tracing a call path — `IAggregator` → factory → implementation — takes more reading for someone new to the code.

Both are real, and both are the price of the testability above. For a system whose credibility rests on its numbers being right, that is a good trade.

---

## 6. The interface

Two front ends over the same `AgentService`, so they cannot drift apart in behaviour.

**Web UI** (`npm run dev`) — three panes:

- **Conversation**, with answers rendered as markdown; the agent uses tables heavily and they would be unreadable as raw text.
- **Agent trace**, showing every tool call live with its arguments as the answer is composed. This is the transparency argument made visible: a reviewer watches the deterministic tools produce the numbers before the prose appears.
- **Data panel**, showing live data vintages, the scoring configuration, all 14 metrics tagged `measured` / `modeled` / `curated`, and a *"What this cannot tell you"* list. It reads from `/api/meta`, so the interface can never claim newer data or different weights than the backend actually holds.

Opening questions are **computed from the snapshot** rather than hard-coded — *"XNA has grown 13.0% a year for three years. What is driving it?"* — so the interface demonstrates it already knows its data before anything is asked. The figures are deterministic; only which four appear is shuffled.

**Voice** (the brief's bonus) — built on the browser's Web Speech API:

- **Speaking to it:** a microphone button transcribes live into the input and submits automatically when you stop.
- **Listening back:** a toggle reads each answer aloud. It speaks **only the opening two-sentence summary**, which is exactly why the system prompt requires every answer to start with one — a spoken ranked table with its percentages and caveats is unusable. Markdown and tables are stripped before synthesis.
- The voice is **selected explicitly** and ranked by quality. Left to itself the browser picks a voice matching the operating system locale, so English is read through whatever language the machine is set to.

No API key, no server round trip, no cost, and nothing to fail during a live demo. Everything sits behind a `VoiceProvider` interface, so a hosted provider is one more implementation away.

**CLI** (`npm run chat`) — the same agent with no build step, so it works immediately on a fresh clone and remains available if anything in the front end breaks.

---

## 7. Where and how AI is used

Three distinct roles, worth separating because they carry different risks.

### ① As the product — the agent itself

Claude Opus 5 with **11 typed tools**. The split is strict:

| The model decides | The code decides |
|---|---|
| Which tool to call, with what arguments | Every number |
| How to phrase the answer | The ranking order |
| When to ask a clarifying question | What is excluded, and why |

The system prompt enforces it: *every number must come from a tool result; never estimate; never reorder a ranking.* `npm run rank` produces the same figures with **no LLM in the path at all** — that is the proof, not the claim.

Tool selection is driven purely by the name, description and JSON schema sent with each request. `npm run tools:preview` prints exactly what the model sees.

Observable behaviour from live runs:
- Asked to compare "LA" and Santa Ana, it **refused to guess**, listed all five LA-basin airports and asked which was meant.
- Asked how confident it was, it **walked back its own claim** — *"19.82% vs 19.81% is one basis point; don't let LAX's 'leader' tag carry any weight"* — and noted that 100% rank stability was partly an artefact of comparing only two airports.

### ② As a design partner

The methodology was worked out through discussion before any of it was written. Options were laid out with their pros and cons, and the design decisions were made from there.

That process is where several of the better choices came from: recognising that cohort normalization alone would rank small airports above mega-hubs, that perturbing only metric weights would overstate confidence, and that persisting the UI transcript without server-side history would leave the agent unable to resolve follow-ups.

### ③ As a code-writing tool

Within the timeframe of the assignment, I chose to write most of the code with AI assistance while **approving every change, directing the architecture, making the business decisions, and testing each component** of the product.

That division kept my attention on the part that most needed judgement: **investigating what data genuinely exists**. That is where the findings that shaped the system came from — that no gate-count API exists anywhere, that BTS On-Time Performance is domestic-only, and that OurAirports and BTS disagree on airport codes.

**Working this way moves quickly, which is exactly why verification is built into the workflow rather than left to review.** Four examples caught by tests and standing audits:

| Bug | Consequence | Caught by |
|---|---|---|
| Mixed domestic and total traffic | Overstated JFK by 28% | A written unit-consistency audit |
| Read the full 11-year history as "current" | SFO reported 25% international; truth is 29% | A live answer that looked slightly off |
| Sentence splitter broke on decimals | "It scores 72.4" spoken as "It scores 72." | A unit test |
| CSS specificity collision | Microphone rendered as a blue box | Visual review |

Hence 100 unit tests plus four standing audits — `verify:coverage`, `validate:domestic`, `validate:config` and `tools:test` — which re-check the system's own assumptions rather than trusting them. All of it runs offline in under a second with `npm run verify:all`, so correctness is cheap to confirm at any point.

---

## 8. Known gaps and what comes next

**Conversation history.** Follow-up questions work throughout a session, but conversations are not stored — closing the tab ends them. The design is worked out: two tables, a repository behind a new port, rehydrating an agent by conversation id, and a sidebar to switch between them. Roughly three hours, the careful part being that Anthropic message content must round-trip exactly so replayed reasoning stays intact.

**Transcript export is the feature I would build first**, at around thirty minutes. Copying a conversation as Markdown *including the tool trace* fits how this system is actually used: an analyst who has just got a good answer wants it in an investment memo, and exporting the trace alongside the prose means the memo carries its own provenance — every figure traceable to the deterministic call that produced it. A history sidebar helps someone revisit a chat; an export helps them do their job with it.

**Other known limits**, each surfaced by the agent rather than hidden:

- No catchment demographics — there is no clean public airport-to-metro crosswalk, so population and income are absent from the model.
- Spill is a lower bound and cannot be attributed to individual routes.
- Congestion metrics cover ~358 of ~1,090 airports, because BTS On-Time Performance only includes carriers above 0.5% of US domestic revenue.

---

## 9. Running it

```bash
npm install && npm run web:install
cp .env.example .env          # add ANTHROPIC_API_KEY

npm run dev                   # API + web UI  → http://localhost:5173
npm run chat                  # CLI, no build step
npm run rank                  # deterministic ranking, no LLM, no API key

npm run verify:all            # typecheck + 100 tests + 4 audits, zero tokens
```

The snapshot is committed, so **no ingest is required** to run any of this.

`CLAUDE.md` carries the full engineering detail: verified data sources, dead ends not worth re-investigating, house style, and the decision log.
