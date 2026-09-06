/**
 * The petty cash engine, as a stable public API for other servers in this repo.
 *
 * `src/index.ts` is the MCP server (tools, licensing, storage). Everything below it --
 * the balance, the reconciliation, the replenishment and the float store -- is generic
 * and is re-exported here so a sibling server can read a float without a second copy of
 * the rules, and so a ledger can use the same account ids.
 *
 * The money formatting is NOT re-exported: it lives in
 * `@theluckystrike/mcp-asset-register/lib`. Neither is the chart of accounts, which lives
 * in `@theluckystrike/mcp-cash-book/lib` and is imported from there, not restated here.
 *
 * Nothing in this module touches the network.
 *
 * Stability: the names below are the contract. `dist/*.js` deep imports are not.
 */
export {
  MAX_MINOR, MAX_ROWS, UNCATEGORISED, balance, firstNegative, lastCount, normaliseCategory,
  reconcile, replenishment, voucherKey, vouchersOf,
} from "./float.js";
export type { Count, Float, Reconciliation, Replenishment, TopUp, Voucher, CategoryTotal } from "./float.js";
export { CASH, CASH_OVER_SHORT, PETTY_CASH, accountName, expenseAccount } from "./accounts.js";
export { dataDir, findFloat, getFloats, getVouchers, lockPath, nextId, resolveFloat, setFloats, setVouchers } from "./store.js";
export { VERSION } from "./version.js";
