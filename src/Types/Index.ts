/**
 * Barrel for the project's type vocabulary.
 *
 * All types live under src/Types. Nothing is declared inline inside a
 * function or class body.
 */

// --- Domain ---------------------------------------------------------------
export type * from './Domain/Airport';
export type * from './Domain/Period';
export type * from './Domain/Metric';
export type * from './Domain/Facility';
export type * from './Domain/Region';

// --- Data / provenance ----------------------------------------------------
export type * from './Data/Source';
export type * from './Data/Coverage';
export type * from './Data/Snapshot';

// --- Scoring --------------------------------------------------------------
export type * from './Scoring/Pillar';
export type * from './Scoring/ScoringConfig';
export type * from './Scoring/Score';
export type * from './Scoring/Normalization';
export type * from './Scoring/Spill';
export type * from './Scoring/Sensitivity';

// --- Agent ----------------------------------------------------------------
export type * from './Agent/Tool';
export type * from './Agent/Session';

// --- Ports (DI contracts) -------------------------------------------------
export type * from './Ports/Logger';
export type * from './Ports/Clock';
export type * from './Ports/Fetchers';
export type * from './Ports/Repositories';
export type * from './Ports/Scoring';
export type * from './Ports/IngestSources';
