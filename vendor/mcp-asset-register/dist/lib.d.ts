/**
 * The depreciation engine, as a stable public API for other servers in this repo.
 *
 * `src/index.ts` is the MCP server (tools, licensing, storage). Everything below it --
 * the bundled rate tables, the schedule arithmetic and the asset store -- is generic and
 * is re-exported here so a sibling server can depreciate an asset without a second copy
 * of the rules, and without a second copy of the tables that would drift from these.
 *
 * Nothing in this module touches the network. The tables are read from disk on first use.
 *
 * Stability: the names below are the contract. `dist/*.js` deep imports are not.
 */
export { currencyDecimals, findRate, formatMoney, schemeTable, table, tableIdFor, SCHEMES, TABLE_IDS } from "./tables.js";
export type { Convention, RateRow, SchemeId, Table, TableHeader, TableId } from "./tables.js";
export { accumulatedTo, allocate, buildSchedule, chargeForMonth, MAX_MINOR, MAX_PERIODS, METHODS, monthKey, monthlyRows, parseDate, parseMonth, UK_POOL_PERIODS, } from "./depreciation.js";
export type { DepreciationInput, Method, MonthRow, Period, Schedule } from "./depreciation.js";
export { dataDir, findAsset, getAssets, lockPath, nextAssetId, setAssets } from "./store.js";
export type { Asset, Disposal } from "./store.js";
export { VERSION } from "./version.js";
