import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getInvoices } from "@theluckystrike/mcp-invoice/lib";
import { getCreditNotes, getPurchaseOrders } from "@theluckystrike/mcp-billing-docs/lib";
import { getDeposits } from "@theluckystrike/mcp-deposits/lib";
import { getAssets } from "@theluckystrike/mcp-asset-register/lib";
function attempt(read) {
    try {
        return { rows: read(), ok: true };
    }
    catch (e) {
        return { rows: [], ok: false, error: e.message };
    }
}
function xdgFile(server, file) {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return join(base, "mcp-servers", server, file);
}
/**
 * Read one of the two stores that publish no library. The file is opened, parsed and
 * closed; on a parse failure the error is returned and the file is left exactly as it is.
 * Quarantining another server's data file would be a write into a store this server
 * promised not to touch.
 */
function readForeign(server, key, keep) {
    const file = xdgFile(server, "data.json");
    if (!existsSync(file))
        return { rows: [], ok: true };
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
    }
    catch (e) {
        return { rows: [], ok: false, error: `${file} did not parse (${e.message}); it was left untouched` };
    }
    const raw = parsed[key];
    if (!Array.isArray(raw)) {
        return { rows: [], ok: false, error: `${file} carries no ${key} array; it was left untouched` };
    }
    return { rows: raw.filter((r) => r && typeof r === "object" && keep(r)), ok: true };
}
export function readSources() {
    return {
        invoices: attempt(getInvoices),
        credit_notes: attempt(getCreditNotes),
        purchase_orders: attempt(getPurchaseOrders),
        deposits: attempt(getDeposits),
        assets: attempt(getAssets),
        expenses: readForeign("expense-tracker", "expenses", (r) => typeof r.date === "string" && typeof r.amount_minor === "number" && typeof r.currency === "string"),
        bank: readForeign("bank-statement", "transactions", (r) => typeof r.date === "string" && typeof r.amount_minor === "number" && typeof r.currency === "string"),
    };
}
/** One line per store, for the `sources` block every answer carries. */
export function sourceReport(s) {
    return [
        { store: "invoice", read: s.invoices.ok, rows: s.invoices.rows.length, error: s.invoices.error },
        { store: "billing-docs credit notes", read: s.credit_notes.ok, rows: s.credit_notes.rows.length, error: s.credit_notes.error },
        { store: "billing-docs purchase orders", read: s.purchase_orders.ok, rows: s.purchase_orders.rows.length, error: s.purchase_orders.error },
        { store: "deposits", read: s.deposits.ok, rows: s.deposits.rows.length, error: s.deposits.error },
        { store: "expense-tracker", read: s.expenses.ok, rows: s.expenses.rows.length, error: s.expenses.error },
        { store: "bank-statement", read: s.bank.ok, rows: s.bank.rows.length, error: s.bank.error },
        { store: "asset-register", read: s.assets.ok, rows: s.assets.rows.length, error: s.assets.error },
    ];
}
/**
 * What an unreadable store costs, named store by store and account by account. A ledger
 * short one store is not wrong by a rounding error, it is wrong by everything that store
 * held, and it still balances, because both legs of the missing entry are missing.
 */
export function degradedNotes(s) {
    const out = [];
    if (!s.invoices.ok) {
        out.push(`The invoice ledger could not be read (${s.invoices.error}). Revenue, receivables, VAT output and every ` +
            `payment received are therefore MISSING from this ledger. It still balances, because both legs are missing.`);
    }
    if (!s.credit_notes.ok) {
        out.push(`The credit note store could not be read (${s.credit_notes.error}). Revenue and VAT output are too high by ` +
            `whatever was credited, and receivables with them.`);
    }
    if (!s.purchase_orders.ok) {
        out.push(`The purchase order store could not be read (${s.purchase_orders.error}). Purchase commitments are a memo and ` +
            `are never posted, so no balance moves; the memo is simply absent.`);
    }
    if (!s.deposits.ok) {
        out.push(`The deposit store could not be read (${s.deposits.error}). Deposits held is missing, and a payment made by ` +
            `applying a deposit is posted against cash instead of against the deposit liability, because the invoice alone cannot say where it came from.`);
    }
    if (!s.expenses.ok) {
        out.push(`The expense ledger could not be read (${s.expenses.error}). Expenses by category and VAT input are MISSING, ` +
            `and every bank debit is therefore unexplained rather than matched.`);
    }
    if (!s.bank.ok) {
        out.push(`The bank import could not be read (${s.bank.error}). No cash line is posted from it in any case; what is lost ` +
            `is the reconciliation, so month_close cannot say which posted cash movement has bank evidence behind it.`);
    }
    if (!s.assets.ok) {
        out.push(`The fixed asset register could not be read (${s.assets.error}). Fixed assets, accumulated depreciation and the ` +
            `depreciation charge are MISSING from this ledger.`);
    }
    return out;
}
