#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLicenseGate, readSharedProfile, withFileLock } from "@theluckystrike/mcp-license";
import { currencyDecimals, formatMoney } from "@theluckystrike/mcp-asset-register/lib";
import { isIsoDate, today } from "@theluckystrike/mcp-quotes/lib";
import { z } from "zod";
import { VERSION } from "./version.js";
import { CASH, CASH_OVER_SHORT, PETTY_CASH, accountName, expenseAccount } from "./accounts.js";
import {
  MAX_MINOR, MAX_ROWS, balance, firstNegative, lastCount, normaliseCategory, reconcile as reconcileFloat,
  replenishment, voucherKey, vouchersOf, type Float, type Voucher,
} from "./float.js";
import {
  dataDir, getFloats, getVouchers, lockPath, nextId, resolveFloat, setFloats, setVouchers,
} from "./store.js";

/**
 * Free tier: ONE float, and twenty vouchers in a calendar month.
 *
 * The reconciliation is never metered. The question this server exists to answer is
 * whether the cash in the tin matches the paperwork, and a free tier that withholds the
 * answer is a demo. What is metered is the volume of record keeping: a second float is a
 * second tin, and twenty vouchers a month is a real one-tin office.
 */
const FREE_FLOATS = 1;
const FREE_VOUCHERS_PER_MONTH = 20;
const MAX_NAME = 200;
const MAX_TEXT = 2000;

const gate = createLicenseGate({ product: "petty-cash" });

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true as const });
const json = (v: unknown) => ok(JSON.stringify(v, null, 2));

const str = (field: string, max: number) => z.string().max(max, `${field} must be ${max} characters or fewer`);

/** Only this server's own store is written, so there is one lock and it is this one. */
function locked<T>(fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(lockPath(), fn, { timeoutMs: 20000 });
}

function checkDate(value: string, field: string): string {
  if (!isIsoDate(value)) throw new Error(`cannot read a date: ${field} "${value}" is not a real date in YYYY-MM-DD form. Nothing was written.`);
  return value;
}

function requirePro(feature: string, toolName: string): void {
  if (!gate.isPro()) throw new Error(`${feature} is Pro. Nothing was written. ${gate.upgradeText(feature, toolName)}`);
}

const money = (minor: number, currency: string) => formatMoney(minor, currency);

/** Minor units as the major-unit decimal string `expense_add` takes. */
function major(minor: number, currency: string): string {
  const d = currencyDecimals(currency);
  return (minor / 10 ** d).toFixed(d);
}

const BASIS =
  "No balance is stored. Every figure is derived on the call from the imprest, the top-ups, the vouchers and what each count found, so a deleted voucher cannot leave a balance behind that still says otherwise. " +
  "A count is a fact about the cash in the tin: once it is recorded the balance is what was counted, and the difference is carried as an over or short rather than repeated at every later count.";

function floatSummary(f: Float, vouchers: Voucher[]) {
  const bal = balance(f, vouchers);
  const last = lastCount(f);
  return {
    id: f.id, name: f.name, currency: f.currency,
    imprest: money(f.imprest_minor, f.currency), imprest_minor: f.imprest_minor,
    balance: money(bal, f.currency), balance_minor: bal,
    custodian: f.custodian ?? null, custodian_source: f.custodian_source,
    opened: f.opened,
    vouchers: vouchersOf(vouchers, f.id).length,
    unreconciled_vouchers: vouchersOf(vouchers, f.id).filter((v) => v.reconciled_on === null).length,
    unreplenished_minor: vouchersOf(vouchers, f.id).filter((v) => v.replenished_on === null).reduce((a, v) => a + v.amount_minor, 0),
    topups: f.topups.length,
    last_count: last ? { date: last.date, counted_minor: last.counted_minor, difference_minor: last.difference_minor } : null,
  };
}

function voucherJson(v: Voucher, currency: string) {
  return {
    id: v.id, date: v.date, amount: money(v.amount_minor, currency), amount_minor: v.amount_minor,
    category: v.category, description: v.description, paid_to: v.paid_to,
    receipt_ref: v.receipt_ref ?? null, reconciled_on: v.reconciled_on, replenished_on: v.replenished_on,
  };
}

function vouchersInMonth(month: string): number {
  return getVouchers().filter((v) => v.date.slice(0, 7) === month).length;
}

/* ------------------------------------------------------------------- server */

const server = new McpServer(
  { name: "mcp-petty-cash", version: VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

const floatArg = str("float", MAX_NAME).optional().describe("The float id, e.g. FLOAT-2026-0001, or its name. Omit when there is only one");

server.registerTool("float_open", {
  title: "Open a petty cash float",
  description: "Open a petty cash float on the imprest system and return its id. The imprest is the cash the tin is topped back up to at every replenishment, in whole minor units. Free tier: one float.",
  inputSchema: {
    name: str("name", MAX_NAME).describe("What this tin is, e.g. Office float or Warehouse float"),
    currency: z.string().regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO code such as EUR").describe("ISO code the cash is held in"),
    imprest_minor: z.number().int().min(1).max(MAX_MINOR).describe("The float amount in whole minor units (integer cents). 50000 is EUR 500.00"),
    custodian: str("custodian", MAX_NAME).optional().describe("Who holds the tin. Defaults to the shared business profile's name"),
    opened: str("opened", 10).optional().describe("The date the float was handed over, YYYY-MM-DD. Default today"),
    note: str("note", MAX_TEXT).optional(),
  },
}, async (a) => {
  try {
    const opened = a.opened ? checkDate(a.opened, "opened") : today();
    const currency = a.currency.toUpperCase();
    const given = (a.custodian ?? "").trim();
    const fromProfile = (readSharedProfile().name ?? "").trim();
    const custodian = given || fromProfile || undefined;
    const notes: string[] = [];
    if (!custodian) {
      notes.push("No custodian: the shared business profile has no name and none was given. Run business_set {name} in the invoice server once and every later float carries it.");
    } else if (!given) {
      notes.push(`Custodian "${custodian}" came from the shared business profile, not from this call. Pass custodian to name someone else.`);
    }
    const rec = await locked(() => {
      const list = getFloats();
      if (!gate.isPro() && list.length >= FREE_FLOATS) {
        throw new Error(
          `the free tier holds ${FREE_FLOATS} float and ${list.length} is already open (${list.map((f) => `${f.id} ${f.name}`).join(", ")}). ` +
          `Vouchers, reconciliation and deletion on that float stay free. Nothing was written. ` + gate.upgradeText("unlimited floats", "float_open"),
        );
      }
      const id = nextId("FLOAT", opened.slice(0, 4), list.map((f) => f.id));
      const now = new Date().toISOString();
      const f: Float = {
        id, name: a.name.trim(), currency, imprest_minor: a.imprest_minor,
        custodian, custodian_source: given ? "call" : custodian ? "shared profile" : "unknown",
        opened, topups: [], counts: [], note: a.note, created: now, updated: now,
      };
      list.push(f);
      setFloats(list);
      return f;
    });
    if (!gate.isPro()) notes.push(`Free tier: ${FREE_VOUCHERS_PER_MONTH} vouchers a calendar month. replenish_request and float_report are Pro.`);
    return json({
      opened: floatSummary(rec, getVouchers()),
      journal: [
        { account: PETTY_CASH, account_name: accountName(PETTY_CASH), debit: rec.imprest_minor, credit: 0, description: `Petty cash float ${rec.id} opened` },
        { account: CASH, account_name: accountName(CASH), debit: 0, credit: rec.imprest_minor, description: `Cash drawn to open ${rec.name}` },
      ],
      journal_note: `Under the imprest system ${PETTY_CASH} stays at ${money(rec.imprest_minor, rec.currency)} from here on. A replenishment credits ${CASH} and debits the expenses, never this account, which only moves if the imprest itself is changed.`,
      notes, basis: BASIS,
    });
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("topup_record", {
  title: "Record cash put into the float",
  description: "Record cash put into the tin, in whole MINOR units, with the date and source, and return the new balance against the imprest. It also reimburses every voucher up to that date, as a replenishment does.",
  inputSchema: {
    amount_minor: z.number().int().min(1).max(MAX_MINOR).describe("Cash added, in whole minor units"),
    date: str("date", 10).describe("The date the cash went in, YYYY-MM-DD"),
    source: str("source", MAX_NAME).describe("Where it came from, e.g. Cheque 0142, Bank withdrawal, or Owner"),
    float: floatArg,
  },
}, async (a) => {
  try {
    const date = checkDate(a.date, "date");
    const out = await locked(() => {
      const floats = getFloats();
      const f = resolveFloat(floats, a.float);
      if (date < f.opened) throw new Error(`${f.id} was opened on ${f.opened} and the top-up is dated ${date}. There was no tin to put cash into yet. Nothing was written.`);
      const vouchers = getVouchers();
      const covered = vouchersOf(vouchers, f.id).filter((v) => v.replenished_on === null && v.date <= date);
      f.topups.push({ date, amount_minor: a.amount_minor, source: a.source.trim(), recorded: new Date().toISOString() });
      f.updated = new Date().toISOString();
      for (const v of covered) v.replenished_on = date;
      setVouchers(vouchers);
      setFloats(floats);
      return { f, covered, vouchers };
    });
    const bal = balance(out.f, out.vouchers);
    const notes: string[] = [];
    if (bal > out.f.imprest_minor) {
      notes.push(`The tin now holds ${money(bal, out.f.currency)}, which is more than the imprest of ${money(out.f.imprest_minor, out.f.currency)}. A top-up larger than what was spent raises the working balance without raising the imprest; reopen the float if the imprest itself has changed.`);
    }
    return json({
      recorded: { date, amount: money(a.amount_minor, out.f.currency), amount_minor: a.amount_minor, source: a.source.trim(), float: out.f.id },
      balance: money(bal, out.f.currency), balance_minor: bal,
      imprest_minor: out.f.imprest_minor,
      vouchers_reimbursed: out.covered.map((v) => v.id),
      vouchers_reimbursed_minor: out.covered.reduce((x, v) => x + v.amount_minor, 0),
      notes, basis: BASIS,
    });
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("voucher_add", {
  title: "Record a petty cash voucher",
  description: "Record one voucher paid out of the tin and return its VOU-YYYY-NNNN number. More than the float holds is refused, and so is a byte-identical duplicate. Free tier: 20 vouchers a calendar month.",
  inputSchema: {
    amount_minor: z.number().int().min(1).max(MAX_MINOR).describe("What was paid out, in whole minor units. 1250 is EUR 12.50"),
    date: str("date", 10).describe("The date the cash left the tin, YYYY-MM-DD"),
    category: str("category", MAX_NAME).describe("What kind of spend, e.g. postage, travel, office. It becomes the expenses:<category> account"),
    description: str("description", MAX_TEXT).describe("What was bought, e.g. Printer paper x5"),
    paid_to: str("paid_to", MAX_NAME).describe("Who was paid, e.g. Corner Shop"),
    receipt_ref: str("receipt_ref", MAX_NAME).optional().describe("The receipt number or where the paper is filed"),
    float: floatArg,
    duplicate_ok: z.boolean().optional().describe("Record it even though an identical voucher exists, for a genuinely repeated purchase. Default false"),
  },
}, async (a) => {
  try {
    const date = checkDate(a.date, "date");
    const now = today();
    if (date > now) throw new Error(`the voucher is dated ${date}, which is after today (${now}). Cash cannot have left the tin yet. Nothing was written.`);
    const category = normaliseCategory(a.category);
    const out = await locked(() => {
      const floats = getFloats();
      const f = resolveFloat(floats, a.float);
      if (date < f.opened) throw new Error(`${f.id} was opened on ${f.opened} and the voucher is dated ${date}. There was no tin to pay it out of yet. Nothing was written.`);
      const vouchers = getVouchers();
      const month = date.slice(0, 7);
      const inMonth = vouchers.filter((v) => v.date.slice(0, 7) === month).length;
      if (!gate.isPro() && inMonth >= FREE_VOUCHERS_PER_MONTH) {
        throw new Error(
          `the free tier records ${FREE_VOUCHERS_PER_MONTH} vouchers a calendar month and ${month} already has ${inMonth}. ` +
          `reconcile and voucher_delete stay free, so the tin can still be counted. Nothing was written. ` + gate.upgradeText("unlimited vouchers", "voucher_add"),
        );
      }
      const draft = {
        float_id: f.id, date, amount_minor: a.amount_minor, category,
        description: a.description.trim(), paid_to: a.paid_to.trim(), receipt_ref: a.receipt_ref?.trim(),
      };
      const key = voucherKey(draft);
      const twin = vouchers.find((v) => voucherKey(v) === key);
      if (twin && !a.duplicate_ok) {
        throw new Error(
          `${twin.id} is already this voucher, to the byte: ${twin.date}, ${money(twin.amount_minor, f.currency)}, ${twin.category}, "${twin.description}", paid to ${twin.paid_to}. ` +
          `Nothing was written. If the same thing really was bought twice, pass duplicate_ok true, or give the second one its own receipt_ref.`,
        );
      }
      const bal = balance(f, vouchers, date);
      if (a.amount_minor > bal) {
        throw new Error(
          `the float held ${money(bal, f.currency)} on ${date} and the voucher is ${money(a.amount_minor, f.currency)}. ` +
          `A float is cash in a tin, so it cannot pay out more than it holds. Record the top-up that funded it first. Nothing was written.`,
        );
      }
      const id = nextId("VOU", date.slice(0, 4), vouchers.map((v) => v.id));
      const v: Voucher = { id, ...draft, reconciled_on: null, replenished_on: null, created: new Date().toISOString() };
      vouchers.push(v);
      const probe = firstNegative(f, vouchers);
      if (probe) {
        throw new Error(
          `that voucher is dated ${date}, and adding it would leave the float at ${money(probe.balance_minor, f.currency)} on ${probe.date}. ` +
          `A back-dated voucher takes the cash out on its own date, so every later day is short too. Nothing was written.`,
        );
      }
      setVouchers(vouchers);
      f.updated = new Date().toISOString();
      setFloats(floats);
      return { f, v, vouchers, twin };
    });
    const bal = balance(out.f, out.vouchers);
    const notes: string[] = [];
    if (!out.v.receipt_ref) notes.push("No receipt reference: the voucher stands on its own, and an auditor has nothing to trace it to. Pass receipt_ref with the receipt number or where the paper is filed.");
    if (out.twin) notes.push(`${out.twin.id} is an identical voucher and was allowed through because duplicate_ok was passed.`);
    if (!gate.isPro()) notes.push(`Free tier: ${vouchersInMonth(out.v.date.slice(0, 7))} of ${FREE_VOUCHERS_PER_MONTH} vouchers in ${out.v.date.slice(0, 7)}.`);
    return json({
      recorded: voucherJson(out.v, out.f.currency),
      float: out.f.id, currency: out.f.currency,
      expense_account: expenseAccount(out.v.category),
      balance: money(bal, out.f.currency), balance_minor: bal,
      imprest_minor: out.f.imprest_minor,
      notes, basis: BASIS,
    });
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("voucher_delete", {
  title: "Delete a voucher",
  description: "Delete a voucher entered wrongly, by its VOU number. One already covered by a reconciliation is refused, naming the count it would falsify: record a correcting voucher instead. Free.",
  inputSchema: {
    voucher: str("voucher", MAX_NAME).describe("The voucher id, e.g. VOU-2026-0003"),
  },
}, async (a) => {
  try {
    const out = await locked(() => {
      const vouchers = getVouchers();
      const needle = a.voucher.trim().toLowerCase();
      const v = vouchers.find((x) => x.id.toLowerCase() === needle);
      if (!v) throw new Error(`no voucher has the id "${a.voucher}". Ids look like VOU-2026-0003. Nothing was written.`);
      if (v.reconciled_on) {
        throw new Error(
          `${v.id} was reconciled on ${v.reconciled_on} and cannot be deleted. The cash it took out was counted that day, so removing it would make that count wrong by ${v.amount_minor} minor units. ` +
          `Record a correcting voucher instead, or count the tin again. Nothing was written.`,
        );
      }
      const floats = getFloats();
      const f = floats.find((x) => x.id === v.float_id);
      const rest = vouchers.filter((x) => x.id !== v.id);
      setVouchers(rest);
      return { v, f, rest };
    });
    const currency = out.f?.currency ?? "EUR";
    return json({
      deleted: voucherJson(out.v, currency),
      float: out.v.float_id,
      balance_minor: out.f ? balance(out.f, out.rest) : null,
      note: "The number is not reissued. The VOU series only ever goes up, so a gap in it is the record that a voucher was deleted.",
      basis: BASIS,
    });
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("reconcile", {
  title: "Count the tin and reconcile",
  description: "Count the tin: give the cash counted in whole MINOR units and the date, and get the expected balance, the difference, and every voucher since the last count, which this marks reconciled. Free.",
  inputSchema: {
    counted_minor: z.number().int().min(0).max(MAX_MINOR).describe("The cash actually counted, in whole minor units"),
    date: str("date", 10).describe("The date it was counted, YYYY-MM-DD"),
    float: floatArg,
  },
}, async (a) => {
  try {
    const date = checkDate(a.date, "date");
    const out = await locked(() => {
      const floats = getFloats();
      const f = resolveFloat(floats, a.float);
      const vouchers = getVouchers();
      if (date < f.opened) throw new Error(`the float was opened on ${f.opened} and the count is dated ${date}. There was no tin to count. Nothing was written.`);
      const last = lastCount(f);
      if (last && date < last.date) {
        throw new Error(`the last count on this float was ${last.date} and this one is dated ${date}. A count cannot be dated before the count before it, because that count already fixed the balance. Nothing was written.`);
      }
      const r = reconcileFloat(f, vouchers, a.counted_minor, date);
      const recorded = new Date().toISOString();
      f.counts.push({
        date, counted_minor: r.counted_minor, expected_minor: r.expected_minor,
        difference_minor: r.difference_minor, vouchers: r.vouchers.map((v) => v.id), recorded,
      });
      f.updated = recorded;
      for (const v of r.vouchers) v.reconciled_on = date;
      setVouchers(vouchers);
      setFloats(floats);
      return { f, r, vouchers };
    });
    const { f, r } = out;
    const notes: string[] = [];
    if (r.difference_minor === 0) notes.push("The tin agrees with the paperwork exactly.");
    else if (r.difference_minor < 0) notes.push(`The tin is SHORT by ${money(-r.difference_minor, f.currency)}. The balance from here is what was counted, and the shortage is carried as ${CASH_OVER_SHORT} into the next replenishment, which is therefore that much larger than the vouchers.`);
    else notes.push(`The tin is OVER by ${money(r.difference_minor, f.currency)}. The balance from here is what was counted, and the overage is carried as ${CASH_OVER_SHORT} into the next replenishment, which is therefore that much smaller than the vouchers.`);
    if (!r.vouchers.length) notes.push("No vouchers had gone unreconciled, so this count only proves the cash that was already accounted for.");
    return json({
      float: f.id, date, currency: f.currency,
      expected: money(r.expected_minor, f.currency), expected_minor: r.expected_minor,
      counted: money(r.counted_minor, f.currency), counted_minor: r.counted_minor,
      difference: money(r.difference_minor, f.currency), difference_minor: r.difference_minor,
      verdict: r.difference_minor === 0 ? "agrees" : r.difference_minor < 0 ? "short" : "over",
      since_last_count: r.since,
      vouchers_reconciled: r.vouchers.map((v) => voucherJson(v, f.currency)),
      vouchers_reconciled_minor: r.vouchers.reduce((x, v) => x + v.amount_minor, 0),
      balance_after: money(balance(f, out.vouchers), f.currency),
      balance_after_minor: balance(f, out.vouchers),
      notes, basis: BASIS,
    });
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("replenish_request", {
  title: "Request a replenishment",
  description: "Work out what puts the float back to its imprest: the amount, the vouchers it reimburses, the totals per category as an expense_add-ready payload, and the double entry. Writes nothing. Pro.",
  inputSchema: {
    float: floatArg,
    date: str("date", 10).optional().describe("The date the request is made, YYYY-MM-DD. Default today"),
  },
}, async (a) => {
  try {
    requirePro("a replenishment request", "replenish_request");
    const date = a.date ? checkDate(a.date, "date") : today();
    const floats = getFloats();
    const f = resolveFloat(floats, a.float);
    const vouchers = getVouchers();
    const r = replenishment(f, vouchers);
    if (r.amount_minor <= 0) {
      throw new Error(
        `${f.id} holds ${money(r.balance_minor, f.currency)} against an imprest of ${money(f.imprest_minor, f.currency)}, so there is nothing to replenish. ` +
        `Record the vouchers that have been paid out first.`,
      );
    }
    const unreconciled = r.vouchers.filter((v) => v.reconciled_on === null);
    const notes: string[] = [];
    if (r.over_short_minor !== 0) {
      notes.push(
        `The request is ${money(r.amount_minor, f.currency)} while the vouchers total ${money(r.vouchers_total_minor, f.currency)}. ` +
        `The ${money(Math.abs(r.over_short_minor), f.currency)} difference is what the counts found ${r.over_short_minor > 0 ? "short" : "over"}, and it is a ${CASH_OVER_SHORT} line, not a voucher. ` +
        `Reimbursing only the voucher total would leave the tin ${money(Math.abs(r.over_short_minor), f.currency)} short for good.`,
      );
    }
    if (unreconciled.length) {
      notes.push(`${unreconciled.length} of these vouchers have not been counted yet (${unreconciled.map((v) => v.id).join(", ")}). Run reconcile first if the cheque should only cover what was verified.`);
    }
    return json({
      float: f.id, name: f.name, date, currency: f.currency,
      balance: money(r.balance_minor, f.currency), balance_minor: r.balance_minor,
      imprest: money(f.imprest_minor, f.currency), imprest_minor: f.imprest_minor,
      request: money(r.amount_minor, f.currency), request_minor: r.amount_minor,
      vouchers_total: money(r.vouchers_total_minor, f.currency), vouchers_total_minor: r.vouchers_total_minor,
      cash_over_short_minor: r.over_short_minor,
      vouchers: r.vouchers.map((v) => voucherJson(v, f.currency)),
      by_category: r.by_category.map((c) => ({ ...c, amount: money(c.amount_minor, f.currency) })),
      expense_add: r.by_category.map((c) => ({
        tool: "expense_add",
        server: "expense-tracker",
        arguments: {
          amount: Number(major(c.amount_minor, f.currency)),
          currency: f.currency,
          category: c.category,
          date,
          merchant: `Petty cash ${f.id}`,
          note: `Petty cash vouchers ${c.vouchers.join(", ")}`,
          billable: false,
        },
      })),
      journal: r.journal.map((l) => ({ ...l, account_name: accountName(l.account) })),
      journal_note: `${PETTY_CASH} does not move: under the imprest system the float account stays at ${money(f.imprest_minor, f.currency)} and the replenishment credits ${CASH} against the expenses.`,
      posted: false,
      note: "Nothing was written. This is the request; record the cash with topup_record when it actually goes into the tin, and post the payload in the server that owns the books.",
      notes, basis: BASIS,
    });
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("float_report", {
  title: "Report the state of the float",
  description: "Report each float: balance against imprest, what it takes to restore it, unreconciled vouchers with their total, the last count, and the history of what counts found over or short. Pro.",
  inputSchema: {
    float: floatArg,
    limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Maximum unreconciled vouchers listed per float, default and ceiling ${MAX_ROWS}`),
  },
}, async (a) => {
  try {
    requirePro("the float report", "float_report");
    const all = getFloats();
    const list = a.float ? [resolveFloat(all, a.float)] : all;
    const vouchers = getVouchers();
    const limit = a.limit ?? MAX_ROWS;
    const per = list.map((f) => {
      const open = vouchersOf(vouchers, f.id).filter((v) => v.reconciled_on === null)
        .sort((x, y) => (x.date === y.date ? x.id.localeCompare(y.id) : x.date < y.date ? -1 : 1));
      const last = lastCount(f);
      const bal = balance(f, vouchers);
      const diffs = f.counts.map((c) => ({ date: c.date, expected_minor: c.expected_minor, counted_minor: c.counted_minor, difference_minor: c.difference_minor, vouchers: c.vouchers.length }));
      const net = diffs.reduce((x, d) => x + d.difference_minor, 0);
      return {
        ...floatSummary(f, vouchers),
        to_replenish_minor: Math.max(0, f.imprest_minor - bal),
        unreconciled: open.slice(0, limit).map((v) => voucherJson(v, f.currency)),
        unreconciled_total_minor: open.reduce((x, v) => x + v.amount_minor, 0),
        unreconciled_truncated: open.length > limit,
        last_count_full: last,
        counts: diffs,
        differences_net_minor: net,
        differences_gross_minor: diffs.reduce((x, d) => x + Math.abs(d.difference_minor), 0),
        counts_that_agreed: diffs.filter((d) => d.difference_minor === 0).length,
      };
    });
    const byCurrency = new Map<string, { currency: string; floats: number; balance_minor: number; imprest_minor: number; differences_net_minor: number }>();
    for (const r of per) {
      const t = byCurrency.get(r.currency) ?? { currency: r.currency, floats: 0, balance_minor: 0, imprest_minor: 0, differences_net_minor: 0 };
      t.floats += 1; t.balance_minor += r.balance_minor; t.imprest_minor += r.imprest_minor;
      t.differences_net_minor += r.differences_net_minor;
      byCurrency.set(r.currency, t);
    }
    return json({
      floats: per.length,
      per_float: per,
      by_currency: [...byCurrency.values()].map((t) => ({
        ...t, balance: money(t.balance_minor, t.currency), imprest: money(t.imprest_minor, t.currency),
      })),
      note: "Currencies are never added together. This server holds no exchange rate, so one balance over a EUR tin and a PLN one would be an invented number.",
      basis: BASIS,
    });
  } catch (e) { return fail((e as Error).message); }
});

gate.registerTools(server);

/* ------------------------------------------------------- resource and prompt */

server.registerResource("accounts", "pettycash://accounts", {
  title: "The accounts a float touches, and where they are written",
  description: "The account ids this server journals to, matching the cash book, and the one directory it writes.",
  mimeType: "application/json",
}, async () => ({
  contents: [{
    uri: "pettycash://accounts", mimeType: "application/json",
    text: JSON.stringify({
      accounts: [
        { account: CASH, name: accountName(CASH), side: "credit", note: "The cash book's own account id, imported from it. The bank cash that opens the float and replenishes it" },
        { account: PETTY_CASH, name: accountName(PETTY_CASH), side: "debit", note: "The float itself. Debited once when the float is opened and never moved again under the imprest system" },
        { account: CASH_OVER_SHORT, name: accountName(CASH_OVER_SHORT), side: "debit", note: "What a count found missing, or a credit for what it found spare. Never a voucher" },
        { account: `${expenseAccount("<category>")}`, name: "Expenses by category", side: "debit", note: "One account per voucher category, built by the cash book's own expenseAccount so the id cannot drift from it" },
      ],
      free_tier: { floats: FREE_FLOATS, vouchers_per_month: FREE_VOUCHERS_PER_MONTH, free_tools: ["float_open", "topup_record", "voucher_add", "voucher_delete", "reconcile"] },
      writes: [{ store: "petty-cash", dir: dataDir(), files: ["floats.json", "vouchers.json", "counter.json"] }],
      posts_to_any_other_store: false,
      today: today(),
    }, null, 2),
  }],
}));

server.registerPrompt("close_the_tin", {
  title: "Close the petty cash tin for the month",
  description: "Count the tin, reconcile the vouchers, and raise the replenishment that puts the float back to its imprest.",
  argsSchema: { month: z.string().describe("The month being closed, YYYY-MM") },
}, ({ month }) => ({
  messages: [{
    role: "user" as const,
    content: {
      type: "text" as const,
      text: `Close the petty cash tin for ${month}.\n\n` +
        `1. Call voucher_add for every receipt in the tin that is not recorded yet: amount in minor units, date, category, description, who was paid, and the receipt reference.\n` +
        `2. Count the physical cash and call reconcile with the counted amount in minor units and the last day of ${month}. Read difference_minor: it is the count minus the paperwork, and it is the only number in this server that no voucher explains.\n` +
        `3. Call replenish_request. The amount is what restores the imprest, and it is the voucher total plus whatever the counts found short. Do not substitute the voucher total for it.\n` +
        `4. Post the expense_add payload in the expense or ledger server, then call topup_record when the cash is physically back in the tin.`,
    },
  }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`mcp-petty-cash ${VERSION} ready; store at ${dataDir()}\n`);
