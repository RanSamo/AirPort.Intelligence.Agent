-- Airport Intelligence Agent — snapshot schema
--
-- Grain notes:
--   traffic_months     airport x month, from BTS T-100 (Socrata r495-tyji)
--   congestion_months  airport x month, aggregated from BTS OTP flight rows
--   haul_mix_months    airport x month, distance-banded flight counts from OTP
--
-- The OTP source is ~275MB uncompressed per month at flight grain. It is
-- streamed and aggregated during ingest; individual flight rows are never
-- stored. What lands here is a few MB, small enough to commit to git so a
-- reviewer can clone and run without a 10-25 minute ingest.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Reference
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS airports (
    iata                  TEXT PRIMARY KEY,
    icao                  TEXT,
    name                  TEXT NOT NULL,
    municipality          TEXT NOT NULL DEFAULT '',
    state                 TEXT NOT NULL DEFAULT '',
    latitude              REAL,
    longitude             REAL,
    hub_class             TEXT NOT NULL DEFAULT 'Nonhub',
    annual_enplanements   INTEGER NOT NULL DEFAULT 0,
    enplanement_share     REAL    NOT NULL DEFAULT 0,
    reports_otp           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_airports_state     ON airports(state);
CREATE INDEX IF NOT EXISTS idx_airports_hub_class ON airports(hub_class);
CREATE INDEX IF NOT EXISTS idx_airports_enplane   ON airports(annual_enplanements DESC);

-- Alternative codes that resolve to a canonical airport.
--
-- The reference and traffic sources do not always agree on an airport's code.
-- OurAirports lists West Palm Beach as DJT (renamed upstream) while BTS still
-- reports PBI; small airports appear in BTS under their FAA local code
-- (1G4, A43) rather than an IATA code. Without this table those airports are
-- silently dropped at join time — 184 airports and 1.4% of US enplanements,
-- including San Juan and West Palm Beach.
--
-- Aliases never overwrite a canonical code: an alias is only registered when
-- no airport already claims it.
CREATE TABLE IF NOT EXISTS airport_aliases (
    alias   TEXT PRIMARY KEY,
    iata    TEXT NOT NULL REFERENCES airports(iata),
    origin  TEXT NOT NULL  -- which field the alias came from, for auditability
);

CREATE INDEX IF NOT EXISTS idx_alias_target ON airport_aliases(iata);

CREATE TABLE IF NOT EXISTS regions (
    region_id   TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    aliases     TEXT NOT NULL,  -- JSON array of lowercased alternative phrasings
    states      TEXT NOT NULL   -- JSON array of two-letter state codes
);

-- ---------------------------------------------------------------------------
-- Curated facility data
--
-- No public API exists for gate counts, runway capacity or slot rules, so
-- these are hand-curated and every value carries its source. An airport
-- absent here simply has no gate count: the Constraint pillar reweights over
-- its remaining metrics and the gap is disclosed. Nothing is ever estimated.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS facilities (
    iata                     TEXT PRIMARY KEY REFERENCES airports(iata),
    gate_count               INTEGER,
    gate_source_url          TEXT,
    gate_retrieved_date      TEXT,
    gate_note                TEXT,
    hourly_capacity          INTEGER,
    hourly_capacity_source   TEXT,
    hourly_capacity_date     TEXT,
    runway_count             INTEGER,
    runway_source_url        TEXT,
    runway_retrieved_date    TEXT,
    slot_controlled          INTEGER NOT NULL DEFAULT 0,
    perimeter_rule           INTEGER NOT NULL DEFAULT 0,
    land_constrained         INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Traffic facts (BTS T-100)
-- ---------------------------------------------------------------------------

-- Domestic columns are NOT redundant with the totals.
--
-- BTS On-Time Performance covers domestic flights only, so any metric that
-- combines an OTP flight count with a T-100 passenger average must use the
-- domestic halves of both or the units do not match. Measured April 2026,
-- blending them misstates passengers-per-flight by +28% at JFK (international
-- widebodies inflate the average) and -15% at ANC (cargo freighters carry no
-- passengers but still count as departures).
CREATE TABLE IF NOT EXISTS traffic_months (
    iata                      TEXT NOT NULL,
    month_key                 TEXT NOT NULL,  -- 'YYYY-MM'
    departures                INTEGER NOT NULL DEFAULT 0,
    passengers                INTEGER NOT NULL DEFAULT 0,
    seats                     INTEGER NOT NULL DEFAULT 0,
    load_factor               REAL    NOT NULL DEFAULT 0,
    domestic_departures       INTEGER NOT NULL DEFAULT 0,
    domestic_passengers       INTEGER NOT NULL DEFAULT 0,
    domestic_seats            INTEGER NOT NULL DEFAULT 0,
    international_passengers  INTEGER NOT NULL DEFAULT 0,
    passenger_miles_avg       REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (iata, month_key)
);

CREATE INDEX IF NOT EXISTS idx_traffic_month ON traffic_months(month_key);

-- ---------------------------------------------------------------------------
-- Congestion facts (aggregated from BTS OTP)
--
-- nas_delay_minutes vs weather_delay_minutes is the most important
-- discriminator in the project: it separates "congested because the
-- infrastructure is saturated" (investable) from "congested because of
-- weather" (not investable).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS congestion_months (
    iata                          TEXT NOT NULL,
    month_key                     TEXT NOT NULL,
    flights                       INTEGER NOT NULL DEFAULT 0,
    taxi_out_p50                  REAL    NOT NULL DEFAULT 0,
    taxi_out_p90                  REAL    NOT NULL DEFAULT 0,
    departures_delayed_15         INTEGER NOT NULL DEFAULT 0,
    cancelled                     INTEGER NOT NULL DEFAULT 0,
    nas_delay_minutes             REAL    NOT NULL DEFAULT 0,
    weather_delay_minutes         REAL    NOT NULL DEFAULT 0,
    carrier_delay_minutes         REAL    NOT NULL DEFAULT 0,
    late_aircraft_delay_minutes   REAL    NOT NULL DEFAULT 0,
    security_delay_minutes        REAL    NOT NULL DEFAULT 0,
    peak_hour_departures          INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (iata, month_key)
);

CREATE INDEX IF NOT EXISTS idx_congestion_month ON congestion_months(month_key);

CREATE TABLE IF NOT EXISTS haul_mix_months (
    iata                  TEXT NOT NULL,
    month_key             TEXT NOT NULL,
    short_haul_flights    INTEGER NOT NULL DEFAULT 0,  -- < 700 sm
    medium_haul_flights   INTEGER NOT NULL DEFAULT 0,  -- 700-2199 sm
    long_haul_flights     INTEGER NOT NULL DEFAULT 0,  -- >= 2200 sm
    total_flights         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (iata, month_key)
);

-- ---------------------------------------------------------------------------
-- Computed metrics
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS metric_values (
    iata         TEXT NOT NULL,
    metric_id    TEXT NOT NULL,
    period_id    TEXT NOT NULL,
    value        REAL NOT NULL,
    sample_size  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (iata, metric_id, period_id)
);

CREATE INDEX IF NOT EXISTS idx_metric_lookup ON metric_values(period_id, metric_id);

-- ---------------------------------------------------------------------------
-- Snapshot metadata (single row, id = 1)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS snapshot_meta (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    payload    TEXT NOT NULL  -- JSON-serialized SnapshotMeta
);
