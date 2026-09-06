// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// The worked month, every figure recomputed by hand and asserted to the minor unit.
//
// The float: EUR 500.00 imprest (50,000 minor units), opened 2026-03-01.
// The vouchers: 1,250 + 3,480 + 899 + 12,500 + 2,065 = 20,194.
// So the paperwork says 50,000 - 20,194 = 29,806 on 2026-03-31.
// The tin holds 29,795, which is ELEVEN minor units short, and eleven is the number the
// whole server is built to keep visible: the replenishment is 20,205, not 20,194.
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, sandbox, cleanup, proKey, FLOAT, MONTH, MONTH_TOTAL, COUNT_DATE, EXPECTED, COUNTED, DIFFERENCE } from "./_client.mjs";

function open(t, opts = {}) {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome, ...opts });
  t.after(() => { c.close(); cleanup(box.dir); });
  return { box, c };
}

async function workedMonth(t, opts = { key: proKey() }) {
  const { box, c } = open(t, opts);
  await c.init();
  const opened = await c.json("float_open", FLOAT);
  assert.ok(opened.opened, JSON.stringify(opened).slice(0, 400));
  for (const v of MONTH) {
    const r = await c.call("voucher_add", v);
    assert.equal(r.isError, false, r.text);
  }
  return { box, c, floatId: opened.opened.id };
}

test("the float opens at its imprest and journals against the cash book's own cash account", async (t) => {
  const { c } = open(t);
  await c.init();
  const r = await c.json("float_open", FLOAT);
  assert.equal(r.opened.id, "FLOAT-2026-0001");
  assert.equal(r.opened.imprest_minor, 50000);
  assert.equal(r.opened.balance_minor, 50000);
  assert.equal(r.opened.custodian, "Anna Kowalska");
  assert.equal(r.opened.custodian_source, "call");
  assert.deepEqual(r.journal.map((l) => [l.account, l.debit, l.credit]), [
    ["petty_cash", 50000, 0],
    ["cash", 0, 50000],
  ]);
});

test("the worked month reconciles to a difference of exactly eleven minor units short", async (t) => {
  const { c } = await workedMonth(t);
  const r = await c.json("reconcile", { counted_minor: COUNTED, date: COUNT_DATE });
  assert.equal(r.expected_minor, EXPECTED, "expected balance is imprest minus the vouchers");
  assert.equal(r.expected_minor, 50000 - MONTH_TOTAL);
  assert.equal(r.counted_minor, COUNTED);
  assert.equal(r.difference_minor, DIFFERENCE);
  assert.equal(r.difference_minor, -11);
  assert.equal(r.difference, "EUR -0.11");
  assert.equal(r.verdict, "short");
  assert.equal(r.since_last_count, null);
  // Every voucher of the month is listed and marked, in date order.
  assert.deepEqual(r.vouchers_reconciled.map((v) => v.id),
    ["VOU-2026-0001", "VOU-2026-0002", "VOU-2026-0003", "VOU-2026-0004", "VOU-2026-0005"]);
  assert.deepEqual(r.vouchers_reconciled.map((v) => v.amount_minor), [1250, 3480, 899, 12500, 2065]);
  assert.equal(r.vouchers_reconciled_minor, MONTH_TOTAL);
  for (const v of r.vouchers_reconciled) assert.equal(v.reconciled_on, COUNT_DATE);
  // The count is a fact: the balance after it IS what was counted.
  assert.equal(r.balance_after_minor, COUNTED);
});

test("a second count the same day, with nothing spent between, finds no difference at all", async (t) => {
  const { c } = await workedMonth(t);
  await c.json("reconcile", { counted_minor: COUNTED, date: COUNT_DATE });
  const again = await c.json("reconcile", { counted_minor: COUNTED, date: COUNT_DATE });
  assert.equal(again.expected_minor, COUNTED, "the first count moved the book balance to the counted cash");
  assert.equal(again.difference_minor, 0);
  assert.equal(again.verdict, "agrees");
  assert.deepEqual(again.vouchers_reconciled, [], "no voucher is reconciled twice");
  assert.equal(again.since_last_count, COUNT_DATE);
});

test("the replenishment is 20,205: the vouchers plus the eleven the count found short", async (t) => {
  const { c } = await workedMonth(t);
  await c.json("reconcile", { counted_minor: COUNTED, date: COUNT_DATE });
  const r = await c.json("replenish_request", { date: "2026-04-01" });
  assert.equal(r.balance_minor, COUNTED);
  assert.equal(r.request_minor, 20205);
  assert.equal(r.request_minor, 50000 - COUNTED);
  assert.equal(r.vouchers_total_minor, MONTH_TOTAL);
  assert.equal(r.cash_over_short_minor, 11);
  assert.equal(r.request_minor - r.vouchers_total_minor, 11);
  assert.equal(r.posted, false);

  // Per category, in the cash book's own account ids: office 899 + 12,500 = 13,399,
  // postage 1,250, travel 3,480 + 2,065 = 5,545. They sum to the voucher total.
  assert.deepEqual(r.by_category.map((c) => [c.account, c.amount_minor]), [
    ["expenses:office", 13399],
    ["expenses:postage", 1250],
    ["expenses:travel", 5545],
  ]);
  assert.equal(r.by_category.reduce((x, c) => x + c.amount_minor, 0), MONTH_TOTAL);

  // The expense_add payload carries MAJOR units, which is what that tool takes.
  assert.deepEqual(r.expense_add.map((e) => [e.tool, e.arguments.category, e.arguments.amount, e.arguments.currency]), [
    ["expense_add", "office", 133.99],
    ["expense_add", "postage", 12.50],
    ["expense_add", "travel", 55.45],
  ].map(([t2, c2, a2]) => [t2, c2, a2, "EUR"]));

  // The double entry balances to the minor unit, and cash is credited the whole cheque.
  const debits = r.journal.reduce((x, l) => x + l.debit, 0);
  const credits = r.journal.reduce((x, l) => x + l.credit, 0);
  assert.equal(debits, credits);
  assert.equal(debits, 20205);
  const cash = r.journal.find((l) => l.account === "cash");
  assert.deepEqual([cash.debit, cash.credit], [0, 20205]);
  const short = r.journal.find((l) => l.account === "cash_over_short");
  assert.deepEqual([short.debit, short.credit], [11, 0]);
  assert.equal(r.journal.some((l) => l.account === "petty_cash"), false, "the imprest account never moves at a replenishment");
});

test("the top-up puts the tin back to its imprest and marks the vouchers reimbursed", async (t) => {
  const { c } = await workedMonth(t);
  await c.json("reconcile", { counted_minor: COUNTED, date: COUNT_DATE });
  const r = await c.json("topup_record", { amount_minor: 20205, date: "2026-04-02", source: "Cheque 0142" });
  assert.equal(r.balance_minor, 50000, "the float is back at its imprest exactly");
  assert.equal(r.vouchers_reimbursed.length, 5);
  assert.equal(r.vouchers_reimbursed_minor, MONTH_TOTAL);
  // And there is nothing left to replenish.
  const again = await c.call("replenish_request", { date: "2026-04-02" });
  assert.equal(again.isError, true);
  assert.match(again.text, /nothing to replenish/);
});

test("reimbursing the voucher total instead leaves the tin short for good, and the report says so", async (t) => {
  // The measured claim in the README, run as arithmetic: three months of an 11 unit
  // shortage reimbursed at the voucher total leaves the float 33 short, while every
  // reconciliation in between still balances against a book that was already wrong.
  const { c } = await workedMonth(t);
  let counted = COUNTED;
  await c.json("reconcile", { counted_minor: counted, date: COUNT_DATE });
  await c.json("topup_record", { amount_minor: MONTH_TOTAL, date: "2026-04-02", source: "Cheque, voucher total" });
  let r = await c.json("float_report", {});
  assert.equal(r.per_float[0].balance_minor, 50000 - 11, "one cycle: eleven short");

  for (const [month, day] of [["04", "30"], ["05", "31"]]) {
    const spend = 1000;
    await c.json("voucher_add", { amount_minor: spend, date: `2026-${month}-05`, category: "postage", description: `Stamps ${month}`, paid_to: "Post Office" });
    counted = 50000 - 11 * Number(month === "04" ? 1 : 2) - spend - 11;
    await c.json("reconcile", { counted_minor: counted, date: `2026-${month}-${day}` });
    await c.json("topup_record", { amount_minor: spend, date: `2026-${month}-${day}`, source: "Cheque, voucher total" });
  }
  r = await c.json("float_report", {});
  assert.equal(r.per_float[0].balance_minor, 50000 - 33, "three cycles: the float is 33 short and no voucher explains any of it");
  assert.equal(r.per_float[0].differences_net_minor, -33);
  assert.equal(r.per_float[0].counts.length, 3);
  assert.equal(r.per_float[0].to_replenish_minor, 33);
});

test("the report names the balance, the unreconciled vouchers, the last count and the differences", async (t) => {
  const { c } = await workedMonth(t);
  const before = await c.json("float_report", {});
  assert.equal(before.per_float[0].unreconciled.length, 5);
  assert.equal(before.per_float[0].unreconciled_total_minor, MONTH_TOTAL);
  assert.equal(before.per_float[0].last_count, null);
  assert.deepEqual(before.per_float[0].counts, []);

  await c.json("reconcile", { counted_minor: COUNTED, date: COUNT_DATE });
  const after = await c.json("float_report", {});
  const f = after.per_float[0];
  assert.equal(f.balance_minor, COUNTED);
  assert.deepEqual(f.unreconciled, []);
  assert.equal(f.last_count.date, COUNT_DATE);
  assert.equal(f.last_count.difference_minor, -11);
  assert.deepEqual(f.counts, [{ date: COUNT_DATE, expected_minor: EXPECTED, counted_minor: COUNTED, difference_minor: -11, vouchers: 5 }]);
  assert.equal(f.differences_net_minor, -11);
  assert.equal(f.differences_gross_minor, 11);
  assert.equal(f.counts_that_agreed, 0);
  assert.equal(f.to_replenish_minor, 20205);
  assert.deepEqual(after.by_currency, [{
    currency: "EUR", floats: 1, balance_minor: COUNTED, imprest_minor: 50000,
    differences_net_minor: -11, balance: "EUR 297.95", imprest: "EUR 500.00",
  }]);
});

test("a voucher deleted before it is counted takes its cash back, and the number is not reissued", async (t) => {
  const { c } = await workedMonth(t);
  const del = await c.json("voucher_delete", { voucher: "VOU-2026-0004" });
  assert.equal(del.deleted.amount_minor, 12500);
  assert.equal(del.balance_minor, 50000 - MONTH_TOTAL + 12500);
  const next = await c.json("voucher_add", { amount_minor: 100, date: "2026-03-25", category: "office", description: "Pens", paid_to: "Corner Shop" });
  assert.equal(next.recorded.id, "VOU-2026-0006", "the deleted number was reissued");
  const r = await c.json("reconcile", { counted_minor: 42206, date: COUNT_DATE });
  assert.equal(r.expected_minor, 50000 - MONTH_TOTAL + 12500 - 100);
  assert.equal(r.difference_minor, 0);
});

test("the custodian comes from the shared business profile when the call does not name one", async (t) => {
  const { box, c } = open(t);
  await c.init();
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(box.dataHome, "mcp-servers", "profile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "business.json"), JSON.stringify({ name: "Nova Studio", default_currency: "EUR" }));
  const r = await c.json("float_open", { name: "Studio tin", currency: "EUR", imprest_minor: 20000, opened: "2026-03-01" });
  assert.equal(r.opened.custodian, "Nova Studio");
  assert.equal(r.opened.custodian_source, "shared profile");
  assert.ok(r.notes.some((n) => /shared business profile/.test(n)), JSON.stringify(r.notes));
});

test("with no profile and no custodian the float still opens, and says the custodian is unknown", async (t) => {
  const { c } = open(t);
  await c.init();
  const r = await c.json("float_open", { name: "Nameless tin", currency: "EUR", imprest_minor: 20000, opened: "2026-03-01" });
  assert.equal(r.opened.custodian, null);
  assert.equal(r.opened.custodian_source, "unknown");
  assert.ok(r.notes.some((n) => /business_set/.test(n)), JSON.stringify(r.notes));
});
