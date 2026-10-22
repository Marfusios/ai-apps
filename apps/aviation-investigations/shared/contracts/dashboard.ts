/**
 * `GET /api/dashboard?cohort=…`: corpus aggregates for "The record, in questions"
 * (UI_DESIGN §4.7). Counts are distinct US events (amendment A14); the phase chart
 * uses the defining event's phase group. Each bar's `facet`/`value` reproduce its
 * count in Explore. Publicly cached per cohort and dataset revision.
 */
import { z } from 'zod';
import { DatasetSchema } from './common.js';
import { FACET_KEYS, YearBucketSchema } from './search.js';

export const DASHBOARD_COHORTS = ['default', 'all'] as const;
export const DashboardRequestSchema = z.object({
  /** `default`: completed with probable cause. `all`: every US record. */
  cohort: z.preprocess((v) => (Array.isArray(v) ? v[0] : v), z.enum(DASHBOARD_COHORTS)).default('default'),
});
export type DashboardRequest = z.infer<typeof DashboardRequestSchema>;

/** One bar. `facet` and `value` open Explore with this cohort and value applied. */
export const DashboardBarSchema = z.strictObject({
  facet: z.enum(FACET_KEYS),
  value: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  count: z.number().int().nonnegative(),
});
export type DashboardBar = z.infer<typeof DashboardBarSchema>;

const share = z.strictObject({ count: z.number().int().nonnegative(), of: z.number().int().nonnegative() });

/** Map frame: an Albers equal-area projection of the lower 48 onto 1000×637. */
export const MAP_FRAME = { width: 1000, height: 637 } as const;

/**
 * Most map points a response may carry: above every US event in the corpus (25,407 in
 * the 2026-10-16 snapshot; one point per event at most), with room for growth.
 */
export const MAX_MAP_POINTS = 60_000;

export const DashboardResponseSchema = z.strictObject({
  dataset: DatasetSchema,
  cohort: z.enum(DASHBOARD_COHORTS),
  /** Events in the cohort. */
  total: z.number().int().nonnegative(),
  /** Every US year in the corpus, completed vs other records; ascending. */
  years: z.array(YearBucketSchema).max(200),
  phase: z.array(DashboardBarSchema).max(40),
  injury: z.array(DashboardBarSchema).max(20),
  weather: z.array(DashboardBarSchema).max(20),
  category: z.array(DashboardBarSchema).max(20),
  coverage: z.strictObject({
    probableCause: share,
    metar: share,
    coordinates: share,
    /** Events with more than one aircraft (aircraft charts can over-count by these). */
    multiAircraft: z.number().int().nonnegative(),
  }),
  map: z.strictObject({
    width: z.literal(MAP_FRAME.width),
    height: z.literal(MAP_FRAME.height),
    projection: z.literal('albers-lower48'),
    /** Projected [x, y] points, rounded to one decimal; events without coordinates are left out. */
    points: z.array(z.tuple([z.number().min(0).max(MAP_FRAME.width), z.number().min(0).max(MAP_FRAME.height)])).max(MAX_MAP_POINTS),
    /** Events with no validated coordinates. */
    withoutCoordinates: z.number().int().nonnegative(),
    /** Events with coordinates outside the lower 48 (Alaska, Hawaii, territories, waters). */
    outsideFrame: z.number().int().nonnegative(),
  }),
});
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;
