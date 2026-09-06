/**
 * The rate tables are BUNDLED JSON, read from disk once at first use and never fetched.
 * There is no network call anywhere in this server. A depreciation rate ends up on a tax
 * return: a figure that changed under the user between two runs of the same register is
 * worse than one that is visibly stale, because the stale one is checkable against the
 * file the build shipped and the moving one is not.
 *
 * Every table carries a `header` naming the authority, the instrument, the source URL,
 * the date the rates took effect and the date they were read, and `asset_rates` returns
 * that header with the rates, so the provenance travels with the number.
 *
 * A value that could not be stated with confidence from the public text is OMITTED, and
 * the header's `coverage` field says what was left out and why. See README.md.
 */
export interface TableHeader {
    scheme: string;
    table: string;
    authority: string;
    instrument: string;
    source_url: string;
    effective_date: string;
    retrieved_date: string;
    currency: string;
    convention: Convention;
    coverage?: string;
    note?: string;
}
export type Convention = "pl-month-following" | "uk-full-period" | "us-half-year";
export interface RateRow {
    code: string;
    name_pl?: string;
    name_en: string;
    /** Annual straight-line or reducing-balance percentage. Absent on the MACRS rows, which are table-driven. */
    rate_pct?: number;
    group?: string;
    /** MACRS only: the published per-year percentages of cost, in order. */
    percentages?: number[];
    life_years?: number;
    method?: "straight-line" | "declining-balance";
    declining_pct?: number;
    declining_allowed?: boolean;
    convention?: string;
    aia_limit_gbp?: number;
    note?: string;
}
export interface Table {
    header: TableHeader;
    declining_coefficient_max?: number;
    rates: RateRow[];
}
declare const FILES: {
    readonly "pl-kst": "pl-kst.json";
    readonly "uk-capital-allowances": "uk-capital-allowances.json";
    readonly "us-macrs": "us-macrs.json";
};
export type TableId = keyof typeof FILES;
export type SchemeId = "pl" | "uk" | "us";
export declare const SCHEMES: SchemeId[];
export declare const TABLE_IDS: TableId[];
export declare function table(id: TableId): Table;
export declare function schemeTable(scheme: SchemeId): Table;
export declare function tableIdFor(scheme: SchemeId): TableId;
/**
 * Resolve a category to a table row: exact code, then exact English or Polish name, then
 * a PREFIX of the name. Never a substring. `"land".includes("and")` is true, and a
 * substring fallback would silently price a piece of equipment at the land row's 0
 * percent and say nothing about it.
 */
export declare function findRate(scheme: SchemeId, category: string): RateRow | undefined;
export declare function currencyDecimals(code: string): number;
export declare function formatMoney(minor: number, code: string): string;
export {};
