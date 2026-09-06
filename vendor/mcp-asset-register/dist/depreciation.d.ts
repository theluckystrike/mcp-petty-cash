import { currencyDecimals, formatMoney, type Convention, type RateRow, type SchemeId } from "./tables.js";
/**
 * The depreciation engine. Three rules live here and nothing else does.
 *
 * 1. Money is integer minor units end to end. Every rate is applied to a float, but the
 *    float never leaves this file: the raw per-period amounts are handed to `allocate`,
 *    which converts them to minor units by CUMULATIVE rounding and makes the last period
 *    absorb the remainder, so the schedule sums to the depreciable base to the cent by
 *    construction rather than by luck. A schedule that is a cent short of the base is a
 *    trial balance that does not balance.
 *
 * 2. The convention is the table's, not the caller's. Poland starts in the month AFTER
 *    the asset enters the register (art. 16h ust. 1 pkt 1), the US GDS tables already
 *    carry the half-year convention inside the published percentages, and a UK writing
 *    down allowance is a full-period allowance on a pool. Every answer names the
 *    convention it used.
 *
 * 3. Nothing is invented. Where a scheme has no statutory concept for something the tool
 *    is asked for -- a useful life for a UK pool, a salvage value under MACRS -- the
 *    answer says the value was derived or ignored, in words, rather than presenting it as
 *    a rate someone published.
 */
export declare const MAX_PERIODS = 120;
/**
 * A UK writing down allowance is a pure reducing balance: it never reaches zero. The
 * schedule is cut at 25 periods and the last one writes off what is left, with the basis
 * line saying so, rather than printing a hundred rows that each shave a penny.
 */
export declare const UK_POOL_PERIODS = 25;
export declare const MAX_MINOR = 100000000000000;
export declare const METHODS: readonly ["straight-line", "declining-balance"];
export type Method = (typeof METHODS)[number];
export interface DepreciationInput {
    scheme: SchemeId;
    category: string;
    cost_minor: number;
    currency: string;
    residual_minor: number;
    purchase_date: string;
    in_service_date: string;
    method: Method;
    life_years?: number;
    rate_pct?: number;
    declining_coefficient?: number;
}
export interface Period {
    index: number;
    year: number;
    months: string[];
    opening_minor: number;
    amount_minor: number;
    amount: string;
    closing_minor: number;
    basis: string;
}
export interface Schedule {
    scheme: SchemeId;
    table: string;
    category: RateRow;
    method: Method;
    convention: Convention;
    currency: string;
    cost_minor: number;
    residual_applied_minor: number;
    depreciable_base_minor: number;
    rate_pct: number;
    useful_life_years: number;
    life_source: string;
    declining_coefficient?: number;
    in_service_date: string;
    first_charge_month: string;
    periods: Period[];
    total_minor: number;
    total: string;
    notes: string[];
    source: {
        authority: string;
        instrument: string;
        source_url: string;
        effective_date: string;
        retrieved_date: string;
    };
}
export declare function parseDate(value: string, field: string): {
    y: number;
    m: number;
    d: number;
};
export declare function monthKey(y: number, m: number): string;
export declare function parseMonth(value: string, field: string): {
    y: number;
    m: number;
};
/**
 * Convert raw float amounts to integer minor units so that they sum EXACTLY to `base`.
 *
 * Rounding each period independently and hoping the total lands on the base is the usual
 * defect: eight periods each half a cent out is four cents of unexplained difference on
 * the balance sheet. Here the CUMULATIVE total is rounded at each step and the period
 * amount is the difference between two rounded cumulatives, and the final period is set
 * to whatever is left, so the identity sum(periods) == base holds for every input.
 */
export declare function allocate(base: number, raws: number[]): number[];
export declare function buildSchedule(input: DepreciationInput): Schedule;
export interface MonthRow {
    month: string;
    amount_minor: number;
    amount: string;
    period: number;
}
/**
 * The monthly view. Each period's exact minor-unit amount is split across that period's
 * months by the same cumulative-rounding rule, so the months of a year sum to the year
 * and the years sum to the base. Nothing is re-derived from a float here.
 */
export declare function monthlyRows(s: Schedule): MonthRow[];
/** Accumulated depreciation charged up to and including `month`. */
export declare function accumulatedTo(s: Schedule, month: string): number;
export declare function chargeForMonth(s: Schedule, month: string): number;
export { currencyDecimals, formatMoney };
