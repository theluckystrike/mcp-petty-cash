/**
 * The ledger engine, as a stable public API for other servers in this repo.
 *
 * `src/index.ts` is the MCP server (tools, licensing, tool copy). Everything below it --
 * the chart of accounts, the posting rules, the bank matching, the trial balance and the
 * CSV writer -- is generic and is re-exported here so a sibling server can derive a
 * double-entry view of the same books without a second copy of the rules.
 *
 * The money formatting is NOT re-exported: it lives in `@theluckystrike/mcp-invoice/lib`.
 * Neither is the payment reconstruction, which lives in
 * `@theluckystrike/mcp-statement-of-account/lib`, nor any writer for the six stores this
 * server reads: it reads those and never writes them.
 *
 * Nothing here touches the network or the licence store at import time.
 *
 * Stability: the names below are the contract. `@theluckystrike/mcp-cash-book/dist/*.js`
 * deep imports are not.
 */
export type { Account, AccountBalance, AccountType, Exception, ExceptionKind, Ledger, Line, Memo, TrialBalance, } from "./ledger.js";
export { accountFor, ACCUMULATED_DEPRECIATION, buildLedger, CASH, currenciesInPeriod, DEPOSITS_HELD, DEPRECIATION_EXPENSE, EXPENSES, expenseAccount, filterLines, FIXED_ASSETS, matchBank, money, monthsBetween, normalSide, pickCurrency, RECEIVABLES, REVENUE, toCsv, trialBalance, VAT_INPUT, VAT_OUTPUT, } from "./ledger.js";
export type { BankRow, ExpenseRow, Source, SourceSet } from "./sources.js";
export { degradedNotes, readSources, sourceReport } from "./sources.js";
export type { CloseRecord, PeriodRecord } from "./store.js";
export { dataDir, findClose, findPeriod, getCloses, getPeriods, lockPath, periodKey, setCloses, setPeriods, } from "./store.js";
export { VERSION } from "./version.js";
