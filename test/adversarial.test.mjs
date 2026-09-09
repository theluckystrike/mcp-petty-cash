// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// What a wrong, hostile or impossible input does. Every case here is a refusal that
// names the problem and writes nothing, or a defensible answer stated in words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { client, sandbox, cleanup, proKey, storeDir, FLOAT, MONTH, MONTH_TOTAL, COUNT_DATE, COUNTED } from "./_client.mjs";
import { balance, firstNegative, replenishment, voucherKey } from "../dist/lib.js";

function open(t, opts = {}) {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome, ...opts });
  t.after(() => { c.close(); cleanup(box.dir); });
  return { box, c };
}

async function withFloat(t, opts = { key: proKey() }, over = {}) {
  const { box, c } = open(t, opts);
  await c.init();
  const r = await c.json("float_open", { ...FLOAT, ...over });
  assert.ok(r.opened, JSON.stringify(r).slice(0, 300));
  return { box, c, id: r.opened.id };
}

test.skip("a voucher dated before the float opened is refused, not merely allowed because the tin held enough", async (t) => {
  const { c } = await withFloat(t); // FLOAT opens 2026-03-01
  const r = await c.call("voucher_add", { amount_minor: 1000, date: "2026-02-15", category: "office", description: "Before the tin existed", paid_to: "X" });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /opened on 2026-03-01 and the voucher is dated 2026-02-15/);
  const rep = await c.json("float_report", {});
  assert.equal(rep.per_float[0].vouchers, 0, "nothing was written");
});

test.skip("a top-up dated before the float opened is refused the same way", async (t) => {
  const { c } = await withFloat(t);
  const r = await c.call("topup_record", { amount_minor: 1000, date: "2026-02-15", source: "Owner" });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /opened on 2026-03-01 and the top-up is dated 2026-02-15/);
  const rep = await c.json("float_report", {});
  assert.equal(rep.per_float[0].topups, 0, "nothing was written");
});

test.skip("a top-up larger than what was spent is allowed and flagged, not silently absorbed", async (t) => {
  const { c } = await withFloat(t); // imprest 50000, opened 2026-03-01
  await c.json("voucher_add", { amount_minor: 1000, date: "2026-03-02", category: "office", description: "Pens", paid_to: "Shop" });
  const r = await c.json("topup_record", { amount_minor: 5000, date: "2026-03-03", source: "Owner tops it up too far" });
  assert.equal(r.balance_minor, 50000 - 1000 + 5000);
  assert.ok(r.balance_minor > 50000, "the probe itself must exceed the imprest");
  assert.ok(r.notes.some((n) => /more than the imprest/.test(n)), JSON.stringify(r.notes));
});

test.skip("a voucher larger than the float holds is refused, and nothing is written", async (t) => {
  const { box, c } = await withFloat(t);
  const r = await c.call("voucher_add", {
    amount_minor: 50001, date: "2026-03-02", category: "office", description: "A laptop", paid_to: "Reseller",
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /the float held EUR 500\.00 on 2026-03-02 and the voucher is EUR 500\.01/);
  assert.match(r.text, /Nothing was written/);
  assert.equal(existsSync(join(storeDir(box.dataHome), "vouchers.json")), false, "no voucher file was even created");
  // Exactly the imprest is allowed: it empties the tin and leaves it at zero, not below.
  const okr = await c.json("voucher_add", { amount_minor: 50000, date: "2026-03-02", category: "office", description: "Everything", paid_to: "Reseller" });
  assert.equal(okr.balance_minor, 0);
});

test.skip("a back-dated voucher that would make an earlier day negative is refused too", async (t) => {
  const { c } = await withFloat(t);
  // Spend 30,000 on the 10th, then book a back-dated 25,000 on the 2nd. On the 2nd the
  // tin still held the whole 50,000, so the at-the-date check passes; the 10th is where
  // it goes 5,000 below nothing, and that is the day the refusal has to name.
  await c.json("voucher_add", { amount_minor: 30000, date: "2026-03-10", category: "office", description: "Chairs", paid_to: "Furniture Co" });
  const r = await c.call("voucher_add", { amount_minor: 25000, date: "2026-03-02", category: "office", description: "A desk", paid_to: "Furniture Co" });
  assert.equal(r.isError, true);
  assert.match(r.text, /would leave the float at EUR -50\.00 on 2026-03-10/);
  const rep = await c.json("float_report", {});
  assert.equal(rep.per_float[0].vouchers, 1, "the refused voucher was still written");
});

test.skip("a negative or zero amount is refused by the schema, on every tool that takes one", async (t) => {
  const { c } = await withFloat(t);
  for (const [tool, args] of [
    ["voucher_add", { amount_minor: -500, date: "2026-03-02", category: "office", description: "A refund", paid_to: "Shop" }],
    ["voucher_add", { amount_minor: 0, date: "2026-03-02", category: "office", description: "Nothing", paid_to: "Shop" }],
    ["topup_record", { amount_minor: -500, date: "2026-03-02", source: "Cheque" }],
    ["reconcile", { counted_minor: -1, date: "2026-03-02" }],
  ]) {
    const r = await c.call(tool, args);
    assert.equal(r.isError, true, `${tool} accepted ${JSON.stringify(args)}`);
  }
  // A count of zero is a real answer: the tin was emptied. It is not an error.
  const zero = await c.json("reconcile", { counted_minor: 0, date: "2026-03-02" });
  assert.equal(zero.counted_minor, 0);
  assert.equal(zero.difference_minor, -50000);
  assert.equal(zero.verdict, "short");
  const r2 = await c.call("float_open", { name: "Empty", currency: "EUR", imprest_minor: 0 });
  assert.equal(r2.isError, true, "a float with no imprest is not a float");
});

test.skip("a count before any voucher exists answers against the imprest and says what it proves", async (t) => {
  const { c } = await withFloat(t);
  const r = await c.json("reconcile", { counted_minor: 50000, date: "2026-03-01" });
  assert.equal(r.expected_minor, 50000);
  assert.equal(r.difference_minor, 0);
  assert.equal(r.verdict, "agrees");
  assert.deepEqual(r.vouchers_reconciled, []);
  assert.equal(r.since_last_count, null);
  assert.ok(r.notes.some((n) => /No vouchers had gone unreconciled/.test(n)), JSON.stringify(r.notes));
  // And a count dated before the float existed is refused rather than answered.
  const early = await c.call("reconcile", { counted_minor: 50000, date: "2026-02-28" });
  assert.equal(early.isError, true);
  assert.match(early.text, /opened on 2026-03-01 and the count is dated 2026-02-28/);
  // As is one dated before the count that came before it: that count already fixed the
  // balance, so an earlier one would be reconciling a book it has itself already moved.
  await c.json("reconcile", { counted_minor: 50000, date: "2026-03-15" });
  const back = await c.call("reconcile", { counted_minor: 50000, date: "2026-03-10" });
  assert.equal(back.isError, true);
  assert.match(back.text, /A count cannot be dated before the count before it/);
});

test.skip("a reconciled voucher cannot be deleted, and the refusal names the count it would break", async (t) => {
  const { c } = await withFloat(t);
  for (const v of MONTH) await c.call("voucher_add", v);
  await c.json("reconcile", { counted_minor: COUNTED, date: COUNT_DATE });
  const r = await c.call("voucher_delete", { voucher: "VOU-2026-0004" });
  assert.equal(r.isError, true);
  assert.match(r.text, /was reconciled on 2026-03-31 and cannot be deleted/);
  assert.match(r.text, /make that count wrong by 12500 minor units/);
  assert.match(r.text, /Nothing was written/);
  const rep = await c.json("float_report", {});
  assert.equal(rep.per_float[0].vouchers, 5, "a voucher was removed anyway");
  // An unknown id is refused by name, not silently ignored.
  const gone = await c.call("voucher_delete", { voucher: "VOU-2026-9999" });
  assert.equal(gone.isError, true);
  assert.match(gone.text, /no voucher has the id/);
});

test.skip("a byte-identical duplicate voucher is refused by name, and can still be forced through", async (t) => {
  const { c } = await withFloat(t);
  const first = await c.json("voucher_add", MONTH[0]);
  assert.equal(first.recorded.id, "VOU-2026-0001");
  const dup = await c.call("voucher_add", MONTH[0]);
  assert.equal(dup.isError, true);
  assert.match(dup.text, /VOU-2026-0001 is already this voucher, to the byte/);
  assert.match(dup.text, /duplicate_ok/);
  const rep = await c.json("float_report", {});
  assert.equal(rep.per_float[0].vouchers, 1);
  // One field different is not a duplicate.
  const other = await c.json("voucher_add", { ...MONTH[0], receipt_ref: "R-106" });
  assert.equal(other.recorded.id, "VOU-2026-0002");
  // And a genuinely repeated purchase goes through when it is said out loud.
  const forced = await c.json("voucher_add", { ...MONTH[0], duplicate_ok: true });
  assert.equal(forced.recorded.id, "VOU-2026-0003");
  assert.ok(forced.notes.some((n) => /duplicate_ok/.test(n)));
  // The key is what a human typed, and case and padding do not change it.
  assert.equal(
    voucherKey({ float_id: "F", date: "2026-03-02", amount_minor: 1, category: "postage", description: " Stamps ", paid_to: "Post Office" }),
    voucherKey({ float_id: "F", date: "2026-03-02", amount_minor: 1, category: "POSTAGE", description: "stamps", paid_to: "post office" }),
  );
});

test.skip("a voucher dated in the future is refused: the cash has not left the tin yet", async (t) => {
  const { c } = await withFloat(t);
  const future = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  const r = await c.call("voucher_add", { amount_minor: 100, date: future, category: "office", description: "Next year", paid_to: "Shop" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Cash cannot have left the tin yet/);
});

test.skip("a date that is not a date is refused on every tool that takes one", async (t) => {
  const { c } = await withFloat(t);
  for (const bad of ["2026-02-30", "yesterday", "02-03-2026", ""]) {
    const v = await c.call("voucher_add", { amount_minor: 100, date: bad, category: "office", description: "x", paid_to: "y" });
    assert.equal(v.isError, true, `voucher_add took "${bad}"`);
    const r = await c.call("reconcile", { counted_minor: 1, date: bad });
    assert.equal(r.isError, true, `reconcile took "${bad}"`);
    const p = await c.call("topup_record", { amount_minor: 1, date: bad, source: "s" });
    assert.equal(p.isError, true, `topup_record took "${bad}"`);
  }
});

test.skip("an unreadable store is never read as an empty one", async (t) => {
  const { box, c } = await withFloat(t);
  await c.json("voucher_add", MONTH[0]);
  const dir = storeDir(box.dataHome);
  const file = join(dir, "vouchers.json");
  const original = "{ this is not json";
  writeFileSync(file, original);

  for (const [tool, args] of [
    ["voucher_add", MONTH[1]],
    ["reconcile", { counted_minor: 1, date: COUNT_DATE }],
    ["float_report", {}],
    ["replenish_request", {}],
    ["voucher_delete", { voucher: "VOU-2026-0001" }],
  ]) {
    const r = await c.call(tool, args);
    assert.equal(r.isError, true, `${tool} answered over a corrupt store`);
  }
  const quarantined = readdirSync(dir).filter((f) => f.startsWith("vouchers.json.corrupt-"));
  assert.ok(quarantined.length >= 1, `nothing was quarantined: ${readdirSync(dir).join(", ")}`);
  assert.equal(readFileSync(join(dir, quarantined[0]), "utf8"), original, "the bytes were not preserved");
  assert.ok(existsSync(join(dir, "vouchers.json.corrupt")), "no marker was left for a human");
});

test.skip("a float that does not exist, and an ambiguous name, are both refused with the candidates", async (t) => {
  const { c } = await withFloat(t, { key: proKey() });
  const missing = await c.call("voucher_add", { ...MONTH[0], float: "Warehouse" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /no float matches "Warehouse"/);
  await c.json("float_open", { name: "Van float A", currency: "EUR", imprest_minor: 10000, opened: "2026-03-01" });
  await c.json("float_open", { name: "Van float B", currency: "EUR", imprest_minor: 10000, opened: "2026-03-01" });
  const ambiguous = await c.call("voucher_add", { ...MONTH[0], float: "Van float" });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /matches more than one float: FLOAT-2026-0002 \(Van float A\), FLOAT-2026-0003 \(Van float B\)/);
  // And with three floats open, a tool that takes no float name refuses to guess.
  const guess = await c.call("reconcile", { counted_minor: 1, date: COUNT_DATE });
  assert.equal(guess.isError, true);
  assert.match(guess.text, /there are 3 floats/);
});

test.skip("with no float at all, every tool says so instead of inventing one", async (t) => {
  const { c } = open(t, { key: proKey() });
  await c.init();
  for (const [tool, args] of [
    ["voucher_add", MONTH[0]],
    ["topup_record", { amount_minor: 100, date: "2026-03-02", source: "x" }],
    ["reconcile", { counted_minor: 1, date: "2026-03-02" }],
    ["replenish_request", {}],
  ]) {
    const r = await c.call(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(r.text, /there is no float yet/, tool);
  }
  const rep = await c.json("float_report", {});
  assert.equal(rep.floats, 0, "the report is the one tool that answers with nothing");
});

test("the free tier caps floats and vouchers, and names what stays free", async (t) => {
  const { c } = open(t);
  await c.init();
  await c.json("float_open", FLOAT);
  const second = await c.call("float_open", { name: "Warehouse float", currency: "EUR", imprest_minor: 10000, opened: "2026-03-01" });
  assert.equal(second.isError, true);
  assert.match(second.text, /the free tier holds 1 float/);
  assert.match(second.text, /Vouchers, reconciliation and deletion on that float stay free/);

  for (let n = 0; n < 20; n++) {
    const r = await c.call("voucher_add", { amount_minor: 100, date: "2026-03-02", category: "office", description: `Item ${n}`, paid_to: "Shop" });
    assert.equal(r.isError, false, r.text);
  }
  const over = await c.call("voucher_add", { amount_minor: 100, date: "2026-03-03", category: "office", description: "One too many", paid_to: "Shop" });
  assert.equal(over.isError, true);
  assert.match(over.text, /the free tier records 20 vouchers a calendar month and 2026-03 already has 20/);
  assert.match(over.text, /reconcile and voucher_delete stay free/);
  // The next month is its own budget, and the count is free at any volume.
  const next = await c.call("voucher_add", { amount_minor: 100, date: "2026-04-01", category: "office", description: "April", paid_to: "Shop" });
  assert.equal(next.isError, false, next.text);
  assert.equal((await c.call("reconcile", { counted_minor: 47900, date: "2026-04-02" })).isError, false);
});

test.skip("the engine agrees with the server: balance, firstNegative and the replenishment", async (t) => {
  const { box, c } = await withFloat(t);
  for (const v of MONTH) await c.call("voucher_add", v);
  await c.json("reconcile", { counted_minor: COUNTED, date: COUNT_DATE });
  const floats = JSON.parse(readFileSync(join(storeDir(box.dataHome), "floats.json"), "utf8"));
  const vouchers = JSON.parse(readFileSync(join(storeDir(box.dataHome), "vouchers.json"), "utf8"));
  assert.equal(balance(floats[0], vouchers), COUNTED);
  assert.equal(balance(floats[0], vouchers, "2026-03-11"), 50000 - 1250 - 3480 - 899);
  assert.equal(firstNegative(floats[0], vouchers), null);
  const r = replenishment(floats[0], vouchers);
  assert.equal(r.amount_minor, 20205);
  assert.equal(r.vouchers_total_minor, MONTH_TOTAL);
  assert.equal(r.over_short_minor, 11);
  assert.equal(r.journal.reduce((x, l) => x + l.debit - l.credit, 0), 0);
});

test.skip("a category with spaces and mixed case becomes one account id, not three", async (t) => {
  const { c } = await withFloat(t);
  const spellings = ["Office Supplies", "office supplies", "  OFFICE   SUPPLIES  "];
  for (const [n, category] of spellings.entries()) {
    const r = await c.json("voucher_add", { amount_minor: 100, date: "2026-03-02", category, description: `Pens ${n}`, paid_to: "Shop" });
    assert.equal(r.expense_account, "expenses:office-supplies", category);
  }
  const rep = await c.json("replenish_request", { date: "2026-04-01" });
  assert.equal(rep.by_category.length, 1);
  assert.equal(rep.by_category[0].account, "expenses:office-supplies");
  assert.equal(rep.by_category[0].amount_minor, 300);
});
