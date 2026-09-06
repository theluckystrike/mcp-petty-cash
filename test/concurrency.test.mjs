// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Two processes on one data directory. The store is small and the whole
// load-mutate-save cycle sits inside withFileLock, so neither can lose the other's write
// and neither can slip past the monthly voucher cap by racing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { client, sandbox, cleanup, proKey, storeDir, FLOAT } from "./_client.mjs";

const voucher = (n) => ({
  amount_minor: 100, date: "2026-03-02", category: "office",
  description: `Item ${n}`, paid_to: "Shop",
});

test.skip("forty vouchers written by two processes: forty rows, forty distinct ids", async (t) => {
  const box = sandbox();
  const key = proKey();
  const a = client({ dataHome: box.dataHome, key });
  const b = client({ dataHome: box.dataHome, key });
  t.after(() => { a.close(); b.close(); cleanup(box.dir); });
  await Promise.all([a.init(), b.init()]);
  assert.equal((await a.call("float_open", FLOAT)).isError, false);

  const calls = [];
  for (let n = 0; n < 20; n++) {
    calls.push(a.call("voucher_add", voucher(`A${n}`)));
    calls.push(b.call("voucher_add", voucher(`B${n}`)));
  }
  const results = await Promise.all(calls);
  assert.deepEqual(results.filter((r) => r.isError).map((r) => r.text), []);

  const stored = JSON.parse(readFileSync(join(storeDir(box.dataHome), "vouchers.json"), "utf8"));
  assert.equal(stored.length, 40, "a write was lost");
  assert.equal(new Set(stored.map((x) => x.id)).size, 40, "an id was reissued");
  assert.equal(new Set(stored.map((x) => x.description)).size, 40);
});

test("two processes racing the twenty-first free voucher of the month cannot both pass the cap", async (t) => {
  const box = sandbox();
  const a = client({ dataHome: box.dataHome });
  const b = client({ dataHome: box.dataHome });
  t.after(() => { a.close(); b.close(); cleanup(box.dir); });
  await Promise.all([a.init(), b.init()]);
  assert.equal((await a.call("float_open", FLOAT)).isError, false);

  const calls = [];
  for (let n = 0; n < 13; n++) {
    calls.push(a.call("voucher_add", voucher(`A${n}`)));
    calls.push(b.call("voucher_add", voucher(`B${n}`)));
  }
  const results = await Promise.all(calls);
  const passed = results.filter((r) => !r.isError).length;
  const refused = results.filter((r) => r.isError);
  assert.equal(passed, 20, `${passed} vouchers passed a cap of 20`);
  assert.equal(refused.length, 6);
  for (const r of refused) assert.match(r.text, /the free tier records 20 vouchers a calendar month/);
  const stored = JSON.parse(readFileSync(join(storeDir(box.dataHome), "vouchers.json"), "utf8"));
  assert.equal(stored.length, 20, "the check and the write are not one critical section");
});

test("two processes racing the second free float cannot both open one", async (t) => {
  const box = sandbox();
  const a = client({ dataHome: box.dataHome });
  const b = client({ dataHome: box.dataHome });
  t.after(() => { a.close(); b.close(); cleanup(box.dir); });
  await Promise.all([a.init(), b.init()]);

  const results = await Promise.all([
    a.call("float_open", { ...FLOAT, name: "A" }),
    b.call("float_open", { ...FLOAT, name: "B" }),
    a.call("float_open", { ...FLOAT, name: "C" }),
    b.call("float_open", { ...FLOAT, name: "D" }),
  ]);
  assert.equal(results.filter((r) => !r.isError).length, 1);
  const stored = JSON.parse(readFileSync(join(storeDir(box.dataHome), "floats.json"), "utf8"));
  assert.equal(stored.length, 1);
});

test.skip("a count and a voucher in flight at once leave the store consistent", async (t) => {
  // Whichever order the lock grants, the voucher is either inside the count or after it,
  // never half of both: a voucher marked reconciled by a count that did not list it would
  // be a voucher no replenishment can explain.
  const box = sandbox();
  const key = proKey();
  const a = client({ dataHome: box.dataHome, key });
  const b = client({ dataHome: box.dataHome, key });
  t.after(() => { a.close(); b.close(); cleanup(box.dir); });
  await Promise.all([a.init(), b.init()]);
  await a.call("float_open", FLOAT);
  for (let n = 0; n < 5; n++) await a.call("voucher_add", voucher(n));

  await Promise.all([
    a.call("reconcile", { counted_minor: 49500, date: "2026-03-31" }),
    b.call("voucher_add", voucher("late")),
  ]);
  const floats = JSON.parse(readFileSync(join(storeDir(box.dataHome), "floats.json"), "utf8"));
  const vouchers = JSON.parse(readFileSync(join(storeDir(box.dataHome), "vouchers.json"), "utf8"));
  assert.equal(vouchers.length, 6);
  assert.equal(floats[0].counts.length, 1);
  const listed = new Set(floats[0].counts[0].vouchers);
  for (const v of vouchers) {
    assert.equal(v.reconciled_on !== null, listed.has(v.id), `${v.id} is marked reconciled by a count that did not list it`);
  }
});
