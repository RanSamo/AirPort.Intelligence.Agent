# CLAUDE.md — Airport Investment Intelligence Agent

> Context file for Claude Code. Everything needed to work on this project without prior chat history.
> **Last updated:** 2026-09-12

---

## 1. What this project is

An AI agent that helps an investment firm identify **US airports where modernization/expansion capital is most likely to pay off**, based on flight and passenger capacity data from public APIs.

It is a take-home exam deliverable (Deloitte Digital, Forward Deployed Engineer role, ~24h timebox).

### Required deliverables
- Source code
- A short design/architecture document (`DESIGN.md`) covering: scoring methodology, key tradeoffs, where/how AI is used

### Requirements from the brief
- Use public APIs to gather airport/aviation data
- Rank or compare airports using **deterministic** logic (not only LLM output)
- Explain its reasoning clearly
- Support conversational follow-up questions
- Chat interface (voice is a bonus)
- Clearly communicate assumptions, uncertainty and scoping

### Benchmark questions the agent must answer
1. Which airports in New England are strong candidates for terminal expansion?
2. Compare LA and Santa Ana airport congestion levels.
3. What is the percentage of long haul flights out of Anchorage airport?
4. What is the unmet flight demand in SFO airport and why?

**These are examples, not the scope.** The system must cover **every US airport the public APIs provide data for** — not a curated shortlist.

---

## 2. The core framing decision (read this first)

The brief says "most profitable." **There is no free public data on airport construction cost**, so we **cannot** compute ROI or IRR, and we must not pretend to.

What we compute is **relative expansion opportunity**. The investment thesis encoded in the score:

> You make money relieving a **binding constraint** on demand that **already exists and is growing**, at an airport where a marginal passenger is **high-yield**, and where nothing structural blocks **realization**.

Those four clauses are the four scoring pillars. This boundary is stated explicitly in `DESIGN.md` and enforced in the agent's system prompt.

---

## 3. Data sources — VERIFIED WORKING (tested 2026-09-12)

### 3.1 BTS On-Time Performance (OTP) — congestion
- **URL pattern:** `https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_<YYYY>_<M>.zip`
- **Auth:** none · **Coverage:** 1987-10 → **2026-06** (690 monthly files)
- **Size:** ~31 MB zipped, **~275 MB uncompressed per month**, ~600k rows/month
- **Grain:** one row per individual flight · **110 columns**
- **Airports covered:** ~350 (only carriers ≥0.5% of domestic revenue must report)

Key columns: `TaxiOut`, `TaxiIn`, `DepDelay`, `DepDel15`, `Cancelled`, `CancellationCode`, `Distance`, `DistanceGroup`, `CRSDepTime`, `DepTimeBlk`, `Origin`, `Dest`, `OriginState`, `OriginCityName`, `Flights`, `Tail_Number`, and the delay-cause split: **`CarrierDelay`, `WeatherDelay`, `NASDelay`, `SecurityDelay`, `LateAircraftDelay`**.

> `NASDelay` vs `WeatherDelay` is the single most important discriminator in the project — it separates *"congested because infrastructure is saturated"* (investable) from *"congested because weather"* (not investable).

> ### ⚠️ OTP IS DOMESTIC-ONLY
> Confirmed empirically 2026-09-12: ATL shows **0.2%** long-haul flights and ORD **0.7%**, because their transatlantic departures are not in the dataset at all. Only carriers with ≥0.5% of domestic scheduled passenger revenue report, and only on **domestic** segments.
>
> Consequences:
> - **Haul mix is DOMESTIC haul mix.** Every answer must say so. For ANC this barely matters (0.2% international passengers), but for JFK (53.4% international) an unqualified haul-mix figure would be badly misleading.
> - All congestion metrics (taxi-out, delay rates, peak-hour) are domestic-flight based.
> - International exposure comes from T-100's passenger split instead, which is a *passenger* share, not a *flight* share. Do not mix the two.

**Ingest cost measured:** ~69 s per month including download. 12 months ≈ 14 min. 351 airports have OTP data.

**Directory listing** (useful for discovering available months): `https://transtats.bts.gov/PREZIP/` returns browsable HTML.

### 3.2 BTS T-100 Segment Summary by Origin Airport — passengers, seats, load factor
- **URL:** `https://data.transportation.gov/resource/r495-tyji.json` (Socrata SODA, supports SoQL)
- **Auth:** none · **Coverage:** 2014-01 → **2026-04**, **1,220 airports**, 131,739 rows total (entire dataset)
- **Grain:** airport × month

Key fields: `origin_airport_code`, `year`, `reporting_month`, `total_departures`, `total_passengers`, `total_seats`, **`total_load_factor`**, `total_passengers_flight`, `total_seats_flight`, `total_distance_flight_sm`, plus full `domestic_*`, `outbound_international_*`, `inbound_international_*` splits.

> Load factor is **given directly** — no derivation needed. International share falls straight out of the domestic/international columns.

Example SoQL:
```
https://data.transportation.gov/resource/r495-tyji.json
  ?$select=origin_airport_code,sum(total_passengers) as pax
  &$where=year='2025'
  &$group=origin_airport_code
  &$order=pax DESC
  &$limit=2000
```

### 3.3 OurAirports — identity & geography
- **URL:** `https://davidmegginson.github.io/ourairports-data/airports.csv` (12.7 MB)
- **Auth:** none
- Columns: `id, ident, type, name, latitude_deg, longitude_deg, elevation_ft, continent, iso_country, iso_region, municipality, scheduled_service, icao_code, iata_code, gps_code, local_code, home_link, wikipedia_link, keywords`
- **Filter `iso_country = 'US'`** — T-100 includes foreign endpoints on international segments.

### 3.4 FAA ACAIS enplanements — official enplanements + hub class
- **URL:** `https://www.faa.gov/airports/planning_capacity/passenger_allcargo_stats/passenger/ARP-cy2024-all-enplanements.xlsx` (151 KB)
- **Auth:** none · CY2024 final. CY2025 final expected late Aug 2026.
- Used as an authoritative cross-check for enplanements and hub classification.

### 3.5 FAA NAS Status — live delay programs
- **URL:** `https://nasstatus.faa.gov/api/airport-status-information`
- **Auth:** none · **Format:** XML · Returns live ground stops, ground delay programs, airport closures, arrival/departure delays.

### 3.6 OpenSky — OPTIONAL live enrichment
- **URL:** `https://opensky-network.org/api/flights/departure?airport=K<ICAO>&begin=<epoch>&end=<epoch>`
- **Auth:** **REQUIRED** — OAuth2 client-credentials (basic auth retired March 2026). Anonymous requests return **403**. Tokens last ~30 min.
- **Status in this project: strictly optional.** Credential-gated via `.env`. **Never feeds the ranking.** If `OPENSKY_CLIENT_ID` is absent the tool is simply not registered and everything else works identically.
- **Purpose:** recency bridge (BTS lags ~3 months) and live-API demo credibility.

---

## 4. Data that does NOT exist — do not re-investigate

These were each tested and confirmed dead on 2026-09-12. Re-litigating them wastes hours.

| Wanted | Verdict |
|---|---|
| **Route-level passengers/seats** (origin→dest) | **Not available free.** TranStats T-100 segment download is behind a JS-rendered form. PREZIP's `T_T100*.zip` files are stale **2015** one-off exports with numeric prefixes (e.g. `896816367_T_T100_SEGMENT_ALL_CARRIER.zip`). `DownLoad_Table.asp` POST returns 404. Socrata `bu82-4pwz` is **national totals only**. |
| **O&D share** (local vs connecting passengers) | **Not available free.** Needs BTS DB1B. **Metric dropped entirely** — not proxied. |
| **Gate counts** | **No public API anywhere.** Not FAA 5010, not ADIP, not NPIAS, not OurAirports. Wikidata has **zero** properties matching "gate" (checked via SPARQL; LAX carries only elevation, area and patronage as numeric properties). Killed the `pax_per_gate` metric — replaced by `peak_hour_passengers`, which measures what gates are a proxy for and needs no curation. |
| **Hourly runway capacity / ASV** | Published only in FAA FACT3, covering ~48 airports, as a PDF. Killed `peak_hour_util`; `taxi_out_p90` and `nas_delay_share` measure saturation directly instead. |
| **Airport → metro-area crosswalk** | No clean public source. Killed all three Census-dependent metrics (`catchment_growth`, `catchment_income`, `epc_gap`). Building one properly is hours of work for one soft signal, and a sloppy one violates the no-guessing rule. The demographic dimension is a stated limitation in DESIGN.md. |
| **Terminal square footage** | Not available. Not attempted. |

### Other dead ends
- `https://www.bts.gov/airline-data-downloads` → **403** to automated fetches
- TranStats HTML pages (`Tables.asp`, `DatabaseInfo.asp`, `databases.asp`) are **JS-rendered** — nothing useful in the initial HTML
- TranStats URL params are ROT13-obfuscated with digits mapped to letters (`gnoyr_VQ` = `table_ID`); not worth decoding
- Socrata **federated** catalog search returns cross-domain junk — always scope with `&search_context=data.transportation.gov`

### ⚠️ The two sources disagree on airport codes — `airport_aliases` is load-bearing

Found by auditing ingest against upstream (`npm run verify:coverage`). Without an alias table, **184 airports and 1.41% of US enplanements were silently dropped**:

| Problem | Example | Fix |
|---|---|---|
| US territories carry their own `iso_country` | SJU is `PR` (6.7M pax, Medium hub), GUM `GU`, STT/STX `VI`, SPN `MP`, PPG `AS` | Accept `US, PR, VI, GU, AS, MP, UM` |
| OurAirports renamed an airport; BTS did not | West Palm Beach: OurAirports `iata_code=DJT`, BTS reports `PBI`. Old code survives only in `keywords` | Register aliases from `iata_code`, `local_code`, `ident` (K-stripped), and `keywords` |
| Small airports use FAA local codes, not IATA | `1G4`, `A43`, `T4X`, `7AK` | Canonical code falls back `iata_code → local_code → ident` |

Aliases never shadow a canonical code (guarded by a `NOT EXISTS` subquery). `AirportCodeResolver` is used by **every** source that joins on an airport code — and by `VerifyCoverage`, which produced a 4.3M-passenger false positive before it resolved aliases too.

**Result: 1,090 of 1,220 airports, 99.993% of US enplanements.** The 130 still missing are tiny Alaskan bush strips (JRV, RBN, RBH, DQS…) absent from OurAirports entirely, worth 0.007% combined.

### Consequence for the spill model
Spill/unmet demand is computed at **airport level** (load factor is available per airport-month), **not route level**. We can quantify *how much* demand SFO turns away; we **cannot** attribute it to specific routes via load factors. Partial "why" attribution comes from OTP route-level *flight* data (frequency flat vs growing, delay concentration by hour/route).

---

## 5. Scope: all US airports

Computed from T-100 CY2025 (total US enplanements **978,500,468**):

| FAA hub class | Threshold | Airports | Share of US pax |
|---|---|---|---|
| Large | ≥1% | **30** | 70.0% |
| Medium | 0.25–1% | **35** | 17.4% |
| Small | 0.05–0.25% | **79** | 9.5% |
| Nonhub | <0.05% | **1,076** | 3.1% |
| **Total reporting** | | **1,220** | 100% |

Cumulative: top 30 → 70.0% · top 70 → 88.6% · top 150 → 97.2% · top 300 → 99.7%

**Decision: ingest all 1,220.** Full coverage is essentially free — T-100's entire dataset is ~131k rows, and OTP is streamed and aggregated regardless of how many airports we keep. DESIGN.md highlights the 30-airport concentration as an *insight*, not as a scope limit.

### Coverage tiers (disclosed, never hidden)
| Tier | Airports | Available |
|---|---|---|
| Full | **358** (OTP-reporting) | All 14 metrics |
| Partial | ~1,250 | Latent demand + monetization only — no congestion metrics, since those need OTP |

---

## 6. Scoring methodology

### 6.1 Four pillars — 14 metrics, every one computable

Verify alignment any time with `npm run validate:config`.

**Pillar 1 — Constraint** (is capacity binding today?)
`taxi_out_p50`, `taxi_out_p90`, `dep_delay_15_rate`, **`nas_delay_share`**, **`peak_hour_passengers`**, `seats_per_departure_trend` (upgauging — airlines fly bigger aircraft when slot-limited, pressuring **terminals before runways**)

**Pillar 2 — Latent demand** (would new capacity get filled?)
`enplanement_cagr_3y`, `seat_cagr_3y`, `avg_load_factor`, `pct_months_lf_gt_85`, **`spill_rate`**

**Pillar 3 — Monetization** (is a marginal passenger high-yield?)
`intl_pax_share`, `long_haul_share` (domestic), `avg_passenger_trip_miles`

**Pillar 4 — Feasibility** — multiplier; curated regulatory flags only.

Provenance mix: **12 measured, 2 modeled** (`peak_hour_passengers`, `spill_rate`). No metric depends on curated data.

> **No metric depends on data we do not have.** Several candidates were designed and then removed for lack of a source — see §4, which lists the unavailable data and why. The rationale for each removal also sits in `MetricRegistry.ts` at the point of use.
>
> Principle: a permanently-absent metric is **worse than no metric**. It drags coverage down and emits exclusion text for every airport while adding zero signal.

### 6.1a ⚠️ Domestic vs total — unit consistency rule

**OTP is domestic-only; T-100 covers all traffic.** Any metric combining an OTP flight count with a T-100 average MUST use the domestic halves of both. Audit with `npm run validate:domestic`.

Measured April 2026, max error across the top 20 airports:

| Quantity | Error if mixed | Rule |
|---|---|---|
| `peak_hour_passengers` | **28.3%** (JFK) | **must use domestic** |
| `seats_per_departure_trend` | **24.4%** (JFK) | **must use domestic** |
| load factor → `avg_load_factor`, `spill_rate`, `pct_months_lf_gt_85` | 3.2% | totals are safe |

Load factor is immune because it is a *ratio* — international flights bring both more passengers and more seats, so pax÷seats barely moves.

The error tracks international share (JFK 53.4% intl → 28%; PHX 5.5% → 0.8%) and **changes sign**: JFK's international widebodies inflate the blended average, while ANC's international *cargo freighters* carry no passengers but still count as departures, deflating it by 15%. So it is not a constant bias that could be ignored — it reorders airports.

Worse, the bias correlates with international exposure, which would reward international hubs inside **Constraint** when they are already rewarded in **Monetization** via `intl_pax_share` — double-counting.

`traffic_months` therefore stores `domestic_departures`, `domestic_seats` and `passenger_miles_avg` alongside the totals.

**Pillar 4 — Feasibility** — a **multiplier (0.5–1.05)**, not a weighted adder
`slot_controlled` (JFK/LGA/DCA → ×0.8), `perimeter_rule` (DCA/LGA → ×0.9), `land_constrained` (×0.85 airfield but **×1.05 terminal-only** — when vertical expansion is the only option, terminal capex *is* the thesis), `spill_absorption` (competing capacity within 100 km), `recent_capex` (FAA AIP/BIL grants per enplanement)

### 6.2 Composite

```
Need     = 0.55·Constraint + 0.45·LatentDemand      (0–100)
Payoff   = Monetization                             (0–100)
Raw      = Need^0.65 · Payoff^0.35                  (geometric, DEFAULT)
         | 0.65·Need + 0.35·Payoff                  (arithmetic, CONFIGURABLE)
Score    = Raw × Feasibility × Materiality
```

### 6.2a ⚠️ Materiality — why cohort normalization alone gives wrong answers

Metrics are normalized **within** an airport's FAA hub-class cohort, which is what makes a Small hub comparable to a Large one. The side effect: the raw score measures **intensity relative to peers**, not the size of the prize.

Observed on the first real run of benchmark question 1 — without this adjustment:

```
BGR  71.7  Nonhub p97   ~250k passengers   ← ranked #1
BOS  65.3  Large  p83   ~21.1M passengers  ← ranked #5
```

Bangor outranking Boston Logan as a terminal-expansion candidate is not a defensible answer for an investor. A 10% capacity gain at Logan supports vastly more deployable capital.

**Fix:** a log-scaled materiality multiplier on annual enplanements (`ScaleAdjuster`), applied alongside feasibility so it stays visible in the waterfall. With `moderate` weighting, BOS → 72.4 (#1) and BGR → 66.5 (#2, still visible as a high-intensity small-cap play at Nonhub p99).

**Logarithmic on purpose.** Boston carries ~90× Bangor's passengers; weighting linearly would collapse the ranking into a passenger-count league table and discard everything the three pillars measure.

Switchable like the aggregation mode, because "how much does deal size matter" is a strategic choice, not a fact: `none` (pure intensity) / `moderate` (default) / `strong`.

**Arithmetic within pillars, geometric across them.** A weighted sum lets one pillar mask a zero in another:

| | Need | Payoff | Arithmetic | Geometric |
|---|---|---|---|---|
| Airport A | 90 | 20 | **65.5** ← wins | 53.2 |
| Airport B | 55 | 55 | 55.0 | **55.0** ← wins |

A is congested but unmonetizable; B is balanced. Geometric refuses that trade — both conditions must hold.

**Gotcha:** geometric is brutal near zero. **Clamp subscores to a floor of ~1** or one missing pillar nukes an airport.

**The aggregation mode is user-switchable** (`ScoringConfig.json` → `"aggregation": "geometric" | "arithmetic"`), exposed as a UI toggle and a `rank_airports` tool parameter. Implemented as an injected strategy via `AggregatorFactory`, never a branch inside the math.

### 6.3 Normalization
1. **Winsorize** each raw metric at p5/p95 within cohort
2. **Robust z-score:** `z = (x − median) / (1.4826 × MAD)` — median/MAD, not mean/stdev (aviation metrics are heavily skewed)
3. **Logistic squash:** `s = 100 / (1 + e^(−1.1z))` — bounded, monotone, far less brittle than min-max
4. **Peer cohorts** = FAA hub class. Report **both** national score and within-cohort percentile (comparing BOS to BDL nationally is meaningless)
5. Flip sign for metrics where lower is better

### 6.4 Missing data — NEVER impute
Renormalize weights over *available* metrics within each pillar; emit `coverage = Σ(available weights) / Σ(total weights)`. Pillar coverage < 0.6 → `low_confidence`. Overall confidence = min pillar coverage.

**There are NO heuristic fallbacks anywhere.** An earlier plan proposed estimating hourly runway capacity from runway count — that was removed, and so was every metric that depended on data we could not source (§4). The remaining gap is coverage-driven: an airport outside OTP reporting simply has no congestion metrics, and the agent says so specifically rather than estimating.

### 6.5 Spill model (unmet demand)
Belobaba/Boeing spill framework, at **airport-month** level:
1. Demand `D ~ Normal(μ, σ)`, `σ = k·μ`, **k ≈ 0.35** (industry range 0.30–0.52)
2. Observed load = `E[min(D, S)]` → solve numerically for `μ`
3. `spill = μ − E[min(D,S)]`; `spill_rate = spill / μ`

**Caveat to state in every answer:** T-100 is segment (nonstop) data, so spill is a **lower bound** and ignores recapture on other flights or nearby airports.

### 6.6 Explainability — exactly-additive waterfall
```
cohort baseline           50.0
+ Constraint    (w=.30)  +12.4
+ LatentDemand  (w=.30)   +8.1
+ Monetization  (w=.25)   −3.2
× Feasibility   (0.85)    −6.7
────────────────────────────────
Score                     60.6
```
Each term is `wᵢ·(sᵢ − 50)`, so it **sums exactly** by construction — SHAP-style attribution with no approximation.

### 6.7 Sensitivity analysis — is the ranking real, or did we manufacture it?

The weights are judgement calls. `SensitivityAnalyzer` resamples them ~400 times and re-ranks, so the agent can tell a finding from an artefact.

**Why it exists.** The first live New England run printed:
```
2  BGR  66.5
3  PWM  66.4
4  PVD  66.4
```
Three airports within **0.1 points**, presented as distinct ranks. Sensitivity confirms they swap 47–49% of the time — they are tied, and saying otherwise overstates the data.

**Output** (`npm run rank -- --sensitivity`):
```
code   baseline  median  range   P(top5)  P(holds rank)
BOS          1       1     1-3     100%            90%
BGR          2       3     1-5     100%            31%
PWM          3       3     1-4     100%            43%
```
Plus `ties[]`, which the agent must surface: *"BGR and PWM trade places in 49% of plausible weightings, so treat them as tied."*

#### ⚠️ Perturb BOTH levels — metric weights alone report false confidence
Two levels of weighting exist, and the second matters more:

| Level | Example |
|---|---|
| Metric weights | how much `taxi_out_p90` counts inside Constraint |
| **Pillar structure** | `needComposition` (0.55/0.45), `geometricExponents` (0.65/0.35) |

Perturbing only metric weights **understates uncertainty**: when every metric inside a pillar moves together the pillar score doesn't change at all, so the ranking looks perfectly stable while the assumption most likely to differ between analysts is never tested. A different analyst is far more likely to disagree about Constraint-vs-Demand than about one metric inside a pillar.

Measured effect: BOS held rank 1 in **100%** of draws under metric-only perturbation, and **90%** once pillar structure was included. The 100% was overconfident. `ScoringOverrides` therefore accepts `needComposition` and `geometricExponents`.

#### Design notes
- **Log-normal** factors (`weightSpread: 0.35`, ≈ ±40%) — symmetric in proportion, so halving is as likely as doubling. Two-way splits are renormalized back to 1.
- **Seeded** (`seed: 20260913`) — a robustness figure that moved between identical questions would undermine the certainty it exists to establish.
- **Fast path:** normalization depends only on the cohort, never the weights, so `PrepareUniverse()` runs once and only the weighted sum repeats. `ScoreSubsetFromPrepared()` scores just the candidate set and skips cohort percentiles. Together: **4,333ms → 154ms** for 400 draws, identical results.
- A uniformly-dominant airport correctly reports 100% stability — reweighting genuinely cannot displace it. Ties only arise between airports with different *shapes*, which is why test fixtures need per-pillar profiles rather than flat percentiles.

### 6.8 Exclusions must be specific and question-aware
Never emit a bare "insufficient data." Carry structured reasons:

```ts
export interface ExclusionReason {
  airport: IataCode;
  airportName: string;
  code: ExclusionCode;              // 'NO_GATE_DATA' | 'NOT_OTP_REPORTING' | 'BELOW_COVERAGE_THRESHOLD'
  missingMetrics: MetricId[];
  coverage: number;
  requiredCoverage: number;
  explanation: string;              // question-aware
}
```

Rendered as: *"Ranked 8 of 14 New England airports. Excluded 6 because they have no verified gate count, which the terminal-pressure pillar requires to assess expansion capacity: BGR, HYA, ORH… You can still ask me about any of them individually."*

Rankings apply a **minimum-coverage filter by default and say so**; any airport remains individually queryable via `get_airport_profile`.

---

## 7. Architecture

### 7.1 Data flow — size affects BUILD time, not RUNTIME
```
INGEST (offline, one-off)
  download .zip → stream-decompress → parse CSV row-by-row
    → aggregate into in-memory counters → row discarded immediately
  Peak RAM: tens of MB. Raw responses cached on disk in .cache/

SNAPSHOT (persists, committed to git, ~few MB)
  airport×month congestion · airport×month T-100 · route×month flights
  · curated facilities · regions · scores

QUERY (every chat message)
  reads local SQLite. Sub-millisecond. ZERO network calls for anything
  that feeds a score. Only the optional live tools touch the network.
```

One-time ingest: ~372 MB download for 12 months of OTP, roughly **10–25 minutes**.

**Not built (demo scope):** scheduled monthly ingest, incremental month-diffing, snapshot migrations. `DESIGN.md` notes these as what production would need.

**Kept:** snapshot stamped with `dataVersion` + `ingestedAt`; cache keys include `configVersion = hash(dataVersion + scoringConfig)`. This is ~10 lines and it guards a real bug — the user-switchable geometric/arithmetic toggle would otherwise serve cached results from the *other* mode.

### 7.2 Caching tiers
| Tier | What | Key / TTL |
|---|---|---|
| L1 | Raw HTTP responses on disk | `.cache/http/<sha256(url)>.json`; OurAirports 30d, FAA enplanements 30d, OpenSky 15m, NAS status 60s |
| L2 | Materialized metrics & scores in SQLite | `(icao, period, dataVersion, scoreVersion)` |
| L3 | Tool results | `sha256(toolName + stableStringify(args) + configVersion)` |
| L4 | Anthropic prompt caching | `cache_control` breakpoint after tools + system prompt |

**Deliberately NOT built:** embedding/semantic cache. A near-miss hit returning right prose with wrong numbers is worse than no cache.

**L4 rule:** keep the system prompt byte-stable — no `new Date()` in it (put "as of" dates in tool results). Verify with `usage.cache_read_input_tokens`; zero across turns means something is silently invalidating.

### 7.3 Agent layer
- `@anthropic-ai/sdk` → `client.beta.messages.toolRunner` with `betaZodTool`
- Model **`claude-opus-5`**, `thinking: { type: "adaptive" }`, `output_config: { effort: "medium" }` (raise to `high` for ranking questions), `stream: true`
- Follow-ups: append-only history + a small `SessionContext` of resolved entities (`lastAirports`, `lastProfile`, `lastWeights`, `lastPeriod`), injected as a **mid-conversation `system` message appended to `messages[]`** (Opus 5 supports this without invalidating the cached prefix — a top-level `system` edit would destroy it)

**Every tool returns one envelope**, so uncertainty can't be dropped:
```ts
export interface ToolEnvelope<TData> {
  data: TData;
  meta: {
    sources: SourceCitation[];
    asOf: string;
    coverage: number;
    exclusions: ExclusionReason[];
    caveats: string[];
    cached: boolean;
  };
}
```

**Tools** (wire names snake_case): `resolve_airports`, `get_airport_profile`, `get_metrics`, `rank_airports`, `compare_airports`, `explain_score`, `estimate_unmet_demand`, `get_haul_mix`, `test_score_sensitivity`, `get_live_status`

**System prompt guardrails:**
- Every number must come from a tool result. Never estimate.
- If `coverage < 0.7`, state the limitation.
- If `resolve_airports` returns multiple similar-confidence candidates, **ask** — don't guess. ("LA" is ambiguous across LAX/BUR/LGB/ONT.)
- Rankings come from `rank_airports`. Never re-order results yourself.
- Always name the metric and the time window.
- Distinguish **measured** (BTS) / **modeled** (spill) / **curated** (gates) values.
- Scope: US commercial-service airports; no construction-cost data, so we rank **opportunity, not IRR**.

### 7.4 UI
- **Backend:** Fastify, `POST /api/chat` streaming SSE events `{ type: "text" | "tool_start" | "tool_result" | "done" }`
- **Frontend:** Vite + React, three panes — Chat, **Agent trace** (every tool call + result, live — the transparency feature), **Score waterfall**
- **Voice:** Web Speech API (`SpeechRecognition` in, `speechSynthesis` out). No key, no server, no cost. Chrome/Edge only; Safari partial — document it. Behind a `VoiceProvider` interface so Deepgram/ElevenLabs is a one-file swap.
  - **Speak only a 2-sentence TL;DR**, not the full answer — a spoken ranked list is unbearable. Every response opens with one.
- **Also ship a CLI** (`npm run chat`) — zero-friction for a reviewer, and a fallback if the web build breaks.

---

## 8. Code conventions — HOUSE STYLE (follow strictly)

These are explicit user preferences. Do not "improve" them.

### Naming
- **PascalCase for files, folders, functions, and classes.** Strictly.
- **camelCase for variables and parameters.**
- Necessary exceptions (approved): tool **wire-name strings** stay `snake_case` (they're API values sent to Claude, and snake_case measurably improves tool selection); React hooks stay `useX` (rules-of-hooks lint requires it); `src/`, `web/`, `package.json`, `tsconfig.json`, `.env` are fixed by tooling.

### Keyed data — NO `Record`, NO `Map`
Use **named interfaces with index signatures**, declared in `src/Types/`:
```ts
export interface AirportsByCode {
  [iataCode: string]: Airport;
}
```
Bonus: unlike `Map`, these serialize natively to JSON (tool envelopes, SSE payloads).

### No index-based lookups — build keyed maps with `.reduce`
```ts
// ❌ never
const bos = airports[0];
const i = codes.indexOf('BOS');

// ⚠️ keyed but O(n²) — avoid, will crawl on ~100k route rows
airports.reduce((acc, a) => ({ ...acc, [a.iata]: a }), {});

// ✅ house style — keyed AND O(n)
const airportsByCode = airports.reduce((accumulator: AirportsByCode, airport) => {
  accumulator[airport.iata] = airport;
  return accumulator;
}, {});
```
Comparisons return nested keyed shapes (metric → airport → value) so positional misalignment is structurally impossible.

### No explicit return type annotations
Return types are **inferred from the returned value**. Parameters stay typed.
```ts
// ✅
public Resolve(mode: AggregationMode) {
  const aggregator = this.aggregators[mode];
  if (!aggregator) throw new UnknownAggregationModeError(mode);
  return aggregator;
}
```
**Only exception:** port interfaces in `src/Types/Ports/` must declare return types — that's what an interface is. Contracts declare, implementations infer, TypeScript verifies conformance.

### Types
- **All types live in `src/Types/`**, subfoldered. Not colocated, not a separate package.
- Nothing declared inline inside a function or class body.
- `strict: true`, but `noUncheckedIndexedAccess: false`. An **explicit `any` is allowed** where it earns its place — don't contort code to avoid it.
- Footgun to watch: with `noUncheckedIndexedAccess` off, `byCode['XXX']` is typed as present even when missing. Guard at lookup sites where the key isn't known-good.

### Dependency injection
Constructor injection + a composition root. **No decorators, no `reflect-metadata`, no DI framework.**
- Interfaces → `src/Types/Ports/`
- Implementations → feature folders
- Wiring → `src/Container/CreateCoreContainer.ts`

Tests call `CreateCoreContainer({ airportRepository: new InMemoryAirportRepository(fixtures) })` — no mocking library needed.

---

## 9. Project structure

```
AirportIntelligenceAgent/
├── package.json · tsconfig.json · .env.example · CLAUDE.md · DESIGN.md · README.md
├── Data/
│   ├── Curated/  AirportFacilities.json · Regions.json
│   └── Snapshot/ Airports.db
├── src/
│   ├── Types/
│   │   ├── Index.ts
│   │   ├── Domain/     Airport.ts · Metric.ts · Period.ts · Facility.ts · Region.ts
│   │   ├── Scoring/    Pillar.ts · Score.ts · ScoringConfig.ts · Normalization.ts
│   │   │               Sensitivity.ts · Spill.ts
│   │   ├── Data/       Source.ts · Coverage.ts · Snapshot.ts
│   │   ├── Agent/      Tool.ts · Session.ts
│   │   └── Ports/      Repositories.ts · Fetchers.ts · IngestSources.ts
│   │                   Scoring.ts · Clock.ts · Logger.ts
│   ├── Container/      CreateCoreContainer.ts · CreateAgentContainer.ts
│   ├── Config/         ScoringConfig.json · LoadScoringConfig.ts
│   ├── Infrastructure/
│   │   ├── Http/       CachedHttpFetcher.ts · FileSystemHttpCache.ts
│   │   ├── Database/   SqliteConnection.ts · Schema.sql
│   │   ├── Clock/      SystemClock.ts
│   │   └── Logging/    ConsoleLogger.ts
│   ├── Repositories/   SqliteAirportRepository.ts · SqliteMetricRepository.ts
│   │                   SqliteScoreRepository.ts
│   ├── Ingest/
│   │   ├── IngestOrchestrator.ts
│   │   ├── Sources/    OurAirportsSource.ts · T100SocrataSource.ts · OtpBulkSource.ts
│   │   │               FaaEnplanementsSource.ts · CuratedFacilitiesSource.ts
│   │   └── Parsers/    CsvStreamParser.ts · ZipEntryReader.ts
│   ├── Metrics/
│   │   ├── MetricRegistry.ts · MetricComputationService.ts
│   │   └── Calculators/ CongestionMetrics.ts · DemandMetrics.ts
│   │                    MonetizationMetrics.ts · FacilityMetrics.ts
│   ├── Scoring/
│   │   ├── ScoringEngine.ts
│   │   ├── Normalizers/  RobustZNormalizer.ts
│   │   ├── Aggregators/  GeometricAggregator.ts · ArithmeticAggregator.ts
│   │   │                 AggregatorFactory.ts
│   │   ├── Pillars/      PillarCalculator.ts
│   │   ├── Feasibility/  FeasibilityAdjuster.ts
│   │   ├── Explain/      WaterfallBuilder.ts
│   │   ├── Spill/        SpillModel.ts
│   │   ├── Sensitivity/  SensitivityAnalyzer.ts
│   │   └── Coverage/     CoverageEvaluator.ts
│   ├── Agent/
│   │   ├── AgentService.ts
│   │   ├── Prompt/   SystemPrompt.ts · Methodology.ts
│   │   ├── Tools/    ToolRegistry.ts · ResolveAirportsTool.ts · GetAirportProfileTool.ts
│   │   │             GetMetricsTool.ts · RankAirportsTool.ts · CompareAirportsTool.ts
│   │   │             ExplainScoreTool.ts · EstimateUnmetDemandTool.ts
│   │   │             GetHaulMixTool.ts · TestScoreSensitivityTool.ts · GetLiveStatusTool.ts
│   │   ├── Cache/    ToolResultCache.ts
│   │   └── Session/  SessionStore.ts
│   ├── Server/       App.ts · Routes/ChatRoute.ts · Routes/HealthRoute.ts
│   └── Scripts/      Ingest.ts · BuildMetrics.ts · Chat.ts
├── Tests/            Scoring/ · Ingest/ · Fixtures/
└── web/src/          App.tsx · Components/{ChatPanel,AgentTrace,ScoreWaterfall,
                      VoiceControl}.tsx · Hooks/useChatStream.ts · Services/VoiceProvider.ts
```

---

## 10. Commands

```bash
npm install
npm run ingest            # one-off, ~25 min; --only <sources> --from/--to to narrow
npm run build:metrics     # compute the 14 metrics into the snapshot (<1s)
npm run rank              # deterministic ranking, no LLM involved
npm test                  # 81 tests, ~0.7s
npm run typecheck

# diagnostics
npm run inspect           # readable slice of the snapshot; --month --airports
npm run verify:coverage   # audits snapshot against live upstream T-100
npm run validate:domestic # domestic/total unit-mixing audit
npm run validate:config   # registry <-> scoring config alignment

# not yet built
npm run chat              # CLI chat
npm run server            # Fastify + SSE backend
```

### `npm run rank` flags
```
--region new_england        --state CA        --airports LAX,SNA,BUR
--profile terminal|airfield|balanced
--aggregation geometric|arithmetic
--scale none|moderate|strong
--top N   --explain   --sensitivity
```

### Environment (`.env`)
```
ANTHROPIC_API_KEY=sk-ant-...      # required for the agent; NOT required for ingest/scoring
OPENSKY_CLIENT_ID=...             # optional — tool is skipped entirely if absent
OPENSKY_CLIENT_SECRET=...
```

**Note:** the `ant` CLI is an Anthropic auth convenience only — unrelated to voice, and not used here. `.env` is the auth path for this project.

---

## 11. Decision log

| # | Decision | Rationale |
|---|---|---|
| 1 | Rank **opportunity**, not ROI/IRR | No public construction-cost data. Stating the boundary beats a fabricated dollar figure. |
| 2 | Pre-built committed snapshot, not live fetch | BTS publishes monthly; live ADS-B can't report passengers. Gives sub-second, reproducible, demo-safe queries. |
| 3 | All ~1,220 US airports, not a top-N shortlist | Full coverage costs ~nothing; user explicitly wants maximum business-opportunity coverage. |
| 4 | Geometric across pillars (default), arithmetic switchable | Prevents one-dimensional winners; user wants the choice exposed. |
| 5 | **No heuristic fallbacks, ever** | User rule: "NO GUESSING. If no data exists we say we don't have it." Removed the runway-count capacity heuristic that an earlier draft proposed. |
| 6 | `od_share` dropped entirely | Requires DB1B; not free. Not proxied. |
| 7 | OpenSky optional, credential-gated, never scores | Not load-bearing; FAA NAS Status covers "live" with zero auth. |
| 8 | No monthly-update machinery | Demo scope. `DESIGN.md` documents what production would need. |
| 9 | No semantic/embedding cache | A near-miss hit with wrong numbers is worse than no cache. |
| 10 | Web Speech API for voice | Zero key, zero cost, zero latency risk. ~60 lines. |
| 11 | Single package + separate `web/`, not npm workspaces | Types are centralized in `src/Types/`, so workspaces stopped earning their complexity. |

---

## 12. Build order (24h timebox)

| Hours | Work |
|---|---|
| 0–1 | Scaffold, tsconfig, SQLite schema |
| 1–4 | **Ingest** — T-100 (all airports, full history) + OTP (12 months: 2025-07 → 2026-06). *Long pole; hard-timebox.* |
| 4–5 | OurAirports + FAA enplanements + regions |
| 5–9 | **Metrics + scoring + spill + waterfall + sensitivity + coverage**, unit-tested on golden fixtures ← *the graded core* |
| 9–12 | Tools + Zod schemas + caching + agent loop + system prompt; **CLI chat working end-to-end** |
| 12–15 | Fastify SSE + React UI + agent trace + waterfall chart |
| 15–16 | Voice |
| 16–18 | FAA live status + OpenSky (optional) |
| 18–20 | Evals on the 4 benchmark questions |
| 20–23 | DESIGN.md, README, demo script |
| 23–24 | Buffer |

**Critical:** get the CLI working end-to-end by hour 12. A working agent with an ugly interface beats a beautiful interface with a broken agent.

### Gate curation — CANCELLED
Originally budgeted 2–3h of manual lookup. Dropped entirely once `peak_hour_passengers` replaced `pax_per_gate` (§4): no metric depends on gate counts any more, so there is nothing to curate. `Data/Curated/AirportFacilities.json` remains, but only for the **feasibility flags** (slot control, perimeter rules, land-constrained), which are published regulatory facts and are already complete for the 9 airports they apply to.

---

## 13. Tests

`npm test` — **81 tests, 9 files**, Vitest. Runs in ~0.5s with no database and no mocking library: `Tests/Fixtures/InMemoryRepositories.ts` supplies in-memory implementations of the ports, which is the payoff of constructor injection.

| File | Guards |
|---|---|
| `Aggregators.test.ts` | **The worked example that justifies the geometric default** — A(90,20) vs B(55,55): arithmetic picks A, geometric picks B. If this flips, the model has stopped encoding the thesis. Also AM-GM inequality, monotonicity, finiteness at zero |
| `Normalizer.test.ts` | Median scores 50; direction flip; 0-100 bounds; subscore floor; **zero-variance cohort scores 50 instead of dividing by zero**; median/MAD survives an outlier that moves the mean by >10,000 |
| `SpillModel.test.ts` | **Round-trip inversion** (construct demand → boardings → recover demand); spill rises with load factor; demand never below boardings; volume-weighted aggregation; null rather than a fabricated number when capacity is missing |
| `Waterfall.test.ts` | **Terms sum exactly to the final score** across all multiplier combinations; running totals consistent; geometric penalty surfaced as its own term |
| `ScaleAdjuster.test.ts` | **The Bangor/Boston case**; log scaling (84× traffic → <1.5× multiplier); monotonic; clamped at floor/ceiling |
| `CoverageAndPillars.test.ts` | Weighted (not counted) coverage; **weights renormalize over available metrics rather than imputing zeros**; exclusion text never reads "insufficient data" |
| `ScoringEngine.test.ts` | End-to-end on fixtures: rank ordering, waterfall reconciliation, **materiality reversing the nonhub-over-mega-hub defect**, cohort normalization, dual-direction land-constraint, every airport either ranked or excluded, determinism |
| `MonthSequence.test.ts` | Month arithmetic across year boundaries; lexical order matches chronological (relied on by every SQL range query) |
| `Sensitivity.test.ts` | Seeded RNG reproducibility; **same question always yields the same robustness figure**; dominant airport reports 100% stability; **tie detection between airports that trade strengths**; unstable order when quality is similar |

### Still to build: agent evals
A harness running the 4 benchmark questions, asserting:
1. The expected tools were called
2. **Every numeric claim in the answer appears in a tool result** — a cheap automatic hallucination detector

---

## 14. Built snapshot — measured results (2026-09-12)

`Data/Snapshot/Airports.db` — **9.59 MB**, committed to git.

| | |
|---|---|
| Airports (reference) | 5,360 |
| Airports with traffic data | 1,615 |
| Airports with congestion data | **358** |
| Code aliases registered | 662 |
| Traffic rows (airport × month) | 115,748 |
| Congestion rows (airport × month) | 4,133 |
| Regions | 15 |
| Curated facility entries | 9 (feasibility flags; **0 gate counts so far**) |
| Traffic coverage | 2015-01 → **2026-04** |
| Congestion coverage | 2025-07 → **2026-06** (12 months) |
| Enplanement coverage vs upstream | **99.993%** |

**Ingest timings:** OurAirports + T-100 ≈ 7 s. OTP 12 months = **1,454 s (~24 min)**, dominated by download, not parsing.

**Spot-checked for plausibility and it holds up:** ORD taxi-out p50 25 min / p90 46 min and JFK 26/49 (both notoriously the worst in the US); ATL only 15 min despite the highest flight count (parallel runway geometry); SFO worst on-time at 36% delayed 15+ (closely-spaced parallels); ANC lowest delays at 12 min; JFK 53.4% international passengers.

### Useful commands
```bash
npm run inspect            # readable slice of the snapshot; --month, --airports
npm run verify:coverage    # audits snapshot against live upstream T-100
```

## 15. Open items

- [ ] `ANTHROPIC_API_KEY` not yet set (not needed for ingest/scoring; needed for the agent layer)
- [ ] OpenSky account not yet created (optional, never scores)
- [x] ~~Gate curation~~ — cancelled; no metric depends on gate counts (§4)
- [x] ~~Census/BEA API key~~ — cancelled; all three Census metrics removed for lack of an airport→metro crosswalk (§4)
- [x] ~~Scoring engine~~ — complete: normalizer, aggregators, pillars, coverage, feasibility, scale, waterfall, spill, sensitivity
- [x] ~~Repositories, MetricComputationService~~ — complete
- [x] ~~Tests~~ — 81 passing
- [ ] **Agent layer** — tools, Zod schemas, system prompt, tool-result cache, CLI chat *(needs `ANTHROPIC_API_KEY`)*
- [ ] Fastify + SSE server, React UI, voice
- [ ] Agent evals on the 4 benchmark questions
- [ ] DESIGN.md, README
