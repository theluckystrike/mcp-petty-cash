import { daysBetween } from "@theluckystrike/mcp-invoice/lib";
import { movements as depositMovements } from "@theluckystrike/mcp-deposits/lib";
/* ------------------------------------------------------------------ clients */
const norm = (s) => String(s ?? "").trim().toLowerCase();
/**
 * A client is matched by invoice-store id, then by exact document name, then by a name
 * CONTAINING the text, in that order, and an ambiguous partial is refused with the
 * candidates rather than resolved to the first hit. A statement is a demand for money;
 * sending one client another client's balance is the worst failure this server has.
 */
export function resolveClient(s, ref) {
    const needle = norm(ref);
    if (!needle)
        throw new Error("client is required.");
    const byId = s.clients.rows.find((c) => norm(c.id) === needle);
    const names = new Set();
    for (const i of s.invoices.rows)
        names.add(i.client.name);
    for (const c of s.credit_notes.rows)
        names.add(c.client.name);
    for (const d of s.deposits.rows)
        names.add(d.client.name);
    let id = byId?.id;
    let name = byId?.name;
    if (!name) {
        const exact = [...names].filter((n) => norm(n) === needle);
        if (exact.length === 1)
            name = exact[0];
        else {
            const partial = [...names].filter((n) => norm(n).includes(needle));
            if (partial.length > 1) {
                throw new Error(`that name matches more than one client: ${partial.sort().join(", ")}. Pass the exact name or the client id.`);
            }
            name = partial[0];
            if (name)
                id = s.clients.rows.find((c) => norm(c.name) === norm(name))?.id;
        }
    }
    if (!name) {
        const known = [...names].sort();
        throw new Error(`no client named "${ref}" appears on any invoice, credit note or deposit. ` +
            (known.length
                ? `The clients in these books are: ${known.join(", ")}.`
                : `There are no invoices, credit notes or deposits on this machine yet, so there is nothing to state.`));
    }
    if (!id)
        id = s.clients.rows.find((c) => norm(c.name) === norm(name))?.id;
    const mine = (rowId, rowName) => (id !== undefined && rowId !== undefined ? rowId === id : false) || norm(rowName) === norm(name);
    const invoices = s.invoices.rows.filter((i) => mine(i.client_id, i.client.name));
    const credit_notes = s.credit_notes.rows.filter((c) => mine(c.client_id, c.client.name));
    const deposits = s.deposits.rows.filter((d) => mine(d.client_id, d.client.name));
    const party = invoices[0]?.client ?? credit_notes[0]?.client ?? deposits[0]?.client ?? { name };
    const currencies = [...new Set([
            ...invoices.map((i) => i.currency.toUpperCase()),
            ...credit_notes.map((c) => c.currency.toUpperCase()),
            ...deposits.map((d) => d.currency.toUpperCase()),
        ])].sort();
    return { id, name, party: { ...party, name }, invoices, credit_notes, deposits, currencies };
}
/**
 * One statement is in ONE currency. A client billed in EUR and in USD has two balances
 * and adding them would be a made-up number: this server holds no exchange rate, so the
 * currency is asked for rather than guessed when there is more than one.
 */
export function pickCurrency(scope, stated) {
    if (stated) {
        const c = stated.toUpperCase();
        if (!scope.currencies.includes(c)) {
            throw new Error(`no document in that currency: ${scope.name} has no ${c} invoice, credit note or deposit. ` +
                `Currencies on this client's books: ${scope.currencies.join(", ") || "none"}.`);
        }
        return c;
    }
    if (scope.currencies.length === 0)
        throw new Error(`there is nothing to state: ${scope.name} has no invoice, credit note or deposit.`);
    if (scope.currencies.length > 1) {
        throw new Error(`one statement is in one currency: ${scope.name} has documents in ${scope.currencies.join(" and ")} and the two are never added up. ` +
            `Pass currency to choose.`);
    }
    return scope.currencies[0];
}
/**
 * Turn one invoice's `paid_minor` into dated payment rows.
 *
 * `paid_minor` is the AUTHORITY and `payments[]` is only the attribution, because the two
 * do not have to agree and on a real machine they usually do not:
 *
 *  - `invoice_mark_paid` appends a `payments[]` row AND raises `paid_minor`.
 *  - `deposit_apply` (servers/deposits) raises `paid_minor` and appends NOTHING to
 *    `payments[]`; the movement lives on the deposit as a `DepositApplication`.
 *  - an invoice created before `payments[]` existed carries `paid_minor` and a single
 *    `paid_date`, and no rows at all.
 *
 * So the rows are assembled as: every `payments[]` row, plus every deposit application
 * naming this invoice, plus one residual row at `paid_date` for whatever `paid_minor`
 * still exceeds those two. The rows therefore sum to `paid_minor` exactly, which is what
 * makes the closing balance reconcile to `total_minor - paid_minor` per invoice.
 *
 * When the attribution sums to MORE than `paid_minor` the invoice and the deposit book
 * disagree about money. Nothing is scaled and nothing is dropped silently: the whole
 * attribution is discarded, a single row for `paid_minor` is used instead, and the
 * disagreement is returned as a warning naming the invoice and the difference.
 */
export function paymentRows(inv, deposits) {
    const number = norm(inv.number);
    const fromRows = (inv.payments ?? [])
        .filter((p) => Number.isFinite(p.amount_minor) && p.amount_minor !== 0)
        .map((p) => ({
        date: p.date,
        kind: "payment",
        reference: inv.number,
        description: `Payment received on ${inv.number}${p.method ? ` by ${p.method}` : ""}${p.reference ? ` (${p.reference})` : ""}`,
        amount_minor: -p.amount_minor,
    }));
    const fromDeposits = [];
    for (const d of deposits) {
        for (const ap of d.applications) {
            if (norm(ap.invoice_number) !== number)
                continue;
            fromDeposits.push({
                date: ap.date,
                kind: "deposit-applied",
                reference: d.id,
                description: `Deposit ${d.id} applied to ${inv.number}`,
                amount_minor: -ap.amount_minor,
            });
        }
    }
    const attributed = [...fromRows, ...fromDeposits].reduce((a, m) => a - m.amount_minor, 0);
    const paid = inv.paid_minor ?? 0;
    if (paid <= 0) {
        if (attributed > 0) {
            return {
                rows: [],
                warning: `${inv.number} records paid_minor 0 but ${attributed} minor units are attributed to it by payment rows or deposit applications. ` +
                    `The attribution was discarded and the invoice is shown unpaid.`,
            };
        }
        return { rows: [] };
    }
    if (attributed > paid) {
        return {
            rows: [{
                    date: inv.paid_date ?? inv.issue_date,
                    kind: "payment",
                    reference: inv.number,
                    description: `Payment received on ${inv.number}`,
                    amount_minor: -paid,
                }],
            warning: `${inv.number} records paid_minor ${paid} but ${attributed} minor units are attributed to it by payment rows and deposit applications. ` +
                `paid_minor is the authority, so the attribution was discarded and one row of ${paid} is shown at ${inv.paid_date ?? inv.issue_date}. ` +
                `The invoice store and the deposit store disagree about this invoice.`,
        };
    }
    const rows = [...fromRows, ...fromDeposits];
    const residual = paid - attributed;
    if (residual > 0) {
        rows.push({
            date: inv.paid_date ?? inv.issue_date,
            kind: "payment",
            reference: inv.number,
            description: rows.length
                ? `Payment received on ${inv.number} (recorded on the invoice, no payment row)`
                : `Payment received on ${inv.number}`,
            amount_minor: -residual,
        });
    }
    return { rows };
}
/* ---------------------------------------------------------------- movements */
const byDate = (a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.reference.localeCompare(b.reference);
/** Every movement on this client's account in one currency, in date order, from the start. */
export function allMovements(scope, currency) {
    const cur = currency.toUpperCase();
    const rows = [];
    const warnings = [];
    const deposits = scope.deposits.filter((d) => d.currency.toUpperCase() === cur);
    for (const inv of scope.invoices) {
        if (inv.currency.toUpperCase() !== cur)
            continue;
        rows.push({
            date: inv.issue_date,
            kind: "invoice",
            reference: inv.number,
            description: `Invoice ${inv.number} issued, due ${inv.due_date}`,
            amount_minor: inv.total_minor,
        });
        const p = paymentRows(inv, deposits);
        rows.push(...p.rows);
        if (p.warning)
            warnings.push(p.warning);
    }
    for (const c of scope.credit_notes) {
        if (c.currency.toUpperCase() !== cur)
            continue;
        // total_minor is stored NEGATIVE by servers/billing-docs, which is the sign a
        // statement wants: it is added, never subtracted, so no row here flips a sign.
        rows.push({
            date: c.issue_date,
            kind: "credit-note",
            reference: c.id,
            description: `Credit note ${c.id} against ${c.invoice_number}: ${c.reason}`,
            amount_minor: c.total_minor,
        });
    }
    rows.sort(byDate);
    return { rows, warnings };
}
/**
 * Build one client's statement for a period.
 *
 * The opening balance is the sum of every signed movement dated strictly BEFORE `from`.
 * The closing balance is the opening balance plus every signed movement in the period.
 * The identity therefore holds by construction rather than by a second calculation that
 * could disagree with the rows printed above it.
 *
 * `deposits_applied_minor` is a SUBSET of the money that left the account, not an extra
 * credit: `deposit_apply` writes the money onto the invoice as `paid_minor`, so counting
 * the deposit application again would pay the invoice twice. It is broken out because a
 * client reading a statement wants to see that their deposit was used, but the ledger
 * only ever moves it once.
 */
export function buildStatement(scope, currency, from, to) {
    if (from > to)
        throw new Error(`the period runs backwards: from ${from} is after to ${to}. A statement period runs forwards.`);
    const cur = currency.toUpperCase();
    const all = allMovements(scope, cur);
    const opening = all.rows.filter((m) => m.date < from).reduce((a, m) => a + m.amount_minor, 0);
    const rows = all.rows.filter((m) => m.date >= from && m.date <= to);
    const sum = (k) => rows.filter((m) => m.kind === k).reduce((a, m) => a + m.amount_minor, 0);
    const invoiced = sum("invoice");
    // Payments received INCLUDE the deposit applications, because `deposit_apply` puts that
    // money on the invoice as paid_minor. `applied` is a breakdown of `paid`, not a fourth
    // column: subtracting it again would pay every deposited invoice twice.
    const applied = -sum("deposit-applied");
    const paid = -sum("payment") + applied;
    const credited = -sum("credit-note");
    return {
        client: scope.party,
        client_id: scope.id,
        currency: cur,
        from, to,
        opening_minor: opening,
        rows,
        invoiced_minor: invoiced,
        paid_minor: paid,
        deposits_applied_minor: applied,
        credited_minor: credited,
        closing_minor: opening + invoiced - paid - credited,
        held_deposit_minor: scope.deposits
            .filter((d) => d.currency.toUpperCase() === cur)
            .reduce((a, d) => a + depositMovements(d).held_minor, 0),
        warnings: all.warnings,
    };
}
/* -------------------------------------------------------------------- aging */
export const BUCKETS = ["0-30", "31-60", "61-90", "over 90"];
export function bucketOf(daysOverdue) {
    if (daysOverdue <= 30)
        return "0-30";
    if (daysOverdue <= 60)
        return "31-60";
    if (daysOverdue <= 90)
        return "61-90";
    return "over 90";
}
/**
 * Age one client's open invoices as at a date.
 *
 * Every figure is taken AS AT `as_of`, not as at now: an invoice issued after the date is
 * not on the books yet, a payment made after it has not happened yet, and a credit note
 * issued after it has not been given yet. Aging that mixes a historic due date with a
 * present-day paid_minor is the standard way to produce a bucket that cannot be
 * reproduced next month.
 *
 * An invoice is overdue only once `as_of` is PAST its due date: due today is not overdue,
 * so day zero sits in "not yet due" and the "0-30" bucket holds days one to thirty.
 *
 * Credit is applied to the invoice it names, never beyond it. A credit note larger than
 * the invoice it reverses cannot make the invoice owe a negative amount, so the open
 * balance floors at zero and the excess is reported separately as unapplied credit rather
 * than quietly cancelling another invoice the client never agreed it against.
 */
export function ageClient(scope, currency, asOf) {
    const cur = currency.toUpperCase();
    const deposits = scope.deposits.filter((d) => d.currency.toUpperCase() === cur);
    const buckets = { "0-30": 0, "31-60": 0, "61-90": 0, "over 90": 0 };
    let notYetDue = 0;
    let unapplied = 0;
    const invoices = [];
    for (const inv of scope.invoices) {
        if (inv.currency.toUpperCase() !== cur)
            continue;
        if (inv.issue_date > asOf)
            continue;
        const paid = paymentRows(inv, deposits).rows
            .filter((m) => m.date <= asOf)
            .reduce((a, m) => a - m.amount_minor, 0);
        const credited = scope.credit_notes
            .filter((c) => c.currency.toUpperCase() === cur && norm(c.invoice_number) === norm(inv.number) && c.issue_date <= asOf)
            .reduce((a, c) => a - c.total_minor, 0);
        const raw = inv.total_minor - paid - credited;
        const open = Math.max(0, raw);
        if (raw < 0)
            unapplied += -raw;
        if (open <= 0)
            continue;
        const days = daysBetween(inv.due_date, asOf);
        const bucket = days <= 0 ? "not yet due" : bucketOf(days);
        if (bucket === "not yet due")
            notYetDue += open;
        else
            buckets[bucket] += open;
        invoices.push({
            number: inv.number, client: scope.name, currency: cur,
            issue_date: inv.issue_date, due_date: inv.due_date,
            total_minor: inv.total_minor, paid_minor: paid, credited_minor: credited,
            open_minor: open, days_overdue: Math.max(0, days), bucket,
        });
    }
    invoices.sort((a, b) => b.days_overdue - a.days_overdue || a.due_date.localeCompare(b.due_date) || a.number.localeCompare(b.number));
    const overdue = BUCKETS.reduce((a, b) => a + buckets[b], 0);
    return {
        currency: cur, buckets, not_yet_due_minor: notYetDue, overdue_minor: overdue,
        outstanding_minor: overdue + notYetDue, unapplied_credit_minor: unapplied, invoices,
    };
}
/** The oldest overdue invoice on a set of aged rows, or undefined when nothing is overdue. */
export function oldestOverdue(rows) {
    const overdue = rows.filter((r) => r.bucket !== "not yet due");
    if (!overdue.length)
        return undefined;
    return overdue.reduce((a, b) => (b.days_overdue > a.days_overdue ? b : a));
}
