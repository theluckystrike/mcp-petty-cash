import { getBusiness, getClients, getInvoices, hasBusiness, } from "@theluckystrike/mcp-invoice/lib";
import { getCreditNotes } from "@theluckystrike/mcp-billing-docs/lib";
import { getDeposits, movements } from "@theluckystrike/mcp-deposits/lib";
function attempt(read) {
    try {
        return { rows: read(), ok: true };
    }
    catch (e) {
        return { rows: [], ok: false, error: e.message };
    }
}
export function readSources() {
    return {
        invoices: attempt(getInvoices),
        credit_notes: attempt(getCreditNotes),
        deposits: attempt(getDeposits),
        clients: attempt(getClients),
    };
}
/** One line per store, for the `sources` field every answer carries. */
export function sourceReport(s) {
    return [
        { store: "invoice", read: s.invoices.ok, rows: s.invoices.rows.length, error: s.invoices.error },
        { store: "billing-docs credit notes", read: s.credit_notes.ok, rows: s.credit_notes.rows.length, error: s.credit_notes.error },
        { store: "deposits", read: s.deposits.ok, rows: s.deposits.rows.length, error: s.deposits.error },
    ];
}
/**
 * The sentence that goes into an answer when a sibling store could not be read. It names
 * the store and says which figure is therefore incomplete, because a statement short one
 * credit note is not wrong by a rounding error, it is wrong by the credit note.
 */
export function degradedNotes(s) {
    const out = [];
    if (!s.credit_notes.ok) {
        out.push(`The credit note store could not be read (${s.credit_notes.error}). Credit notes are therefore MISSING from ` +
            `every figure below, so the closing balance is too high by whatever was credited. This is not an empty store; it is an unreadable one.`);
    }
    if (!s.deposits.ok) {
        out.push(`The deposit store could not be read (${s.deposits.error}). A deposit applied to an invoice is still counted, because ` +
            `deposit_apply writes it onto the invoice as paid_minor; what is missing is the label saying which payment came from a deposit, ` +
            `and the memo of what is still held.`);
    }
    if (!s.clients.ok) {
        out.push(`The client list could not be read (${s.clients.error}). Clients are matched by the name stored on each document instead.`);
    }
    return out;
}
/** Refusal text for the one store a statement cannot be built without. */
export function invoicesUnreadable(s, toolName) {
    return `the invoice store could not be read (${s.invoices.error}). ` +
        `A statement of account is a view over the invoice ledger, so ${toolName} cannot answer at all rather than answer with nothing owed. ` +
        `Nothing was written.`;
}
const PLACEHOLDER_ISSUER = "Your business";
export const NO_BUSINESS_NOTE = "No business profile yet: this document shows a placeholder issuer and no bank details. " +
    "Run business_set {name, address, vat_id, iban, bank} in the invoice server (mcp-invoice) and render again.";
/** Never throws: an unreadable business profile degrades to the placeholder issuer. */
export function issuer() {
    try {
        const b = getBusiness();
        return b.name.trim() ? b : { ...b, name: PLACEHOLDER_ISSUER };
    }
    catch {
        return {
            name: PLACEHOLDER_ISSUER, default_currency: "EUR", default_tax_rate: 0,
            payment_terms_days: 14, invoice_prefix: "INV",
        };
    }
}
export function businessMissing() {
    try {
        return !hasBusiness() || !getBusiness().name.trim();
    }
    catch {
        return true;
    }
}
/** Still-held deposit money per currency for one client, a memo line on the statement. */
export function heldFor(deposits, currency) {
    return deposits
        .filter((d) => d.currency.toUpperCase() === currency.toUpperCase())
        .reduce((a, d) => a + movements(d).held_minor, 0);
}
