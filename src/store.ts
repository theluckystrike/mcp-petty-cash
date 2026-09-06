import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "@theluckystrike/mcp-timezone/lib";
import type { Float, Voucher } from "./float.js";

/**
 * Floats and vouchers live in this server's OWN data directory,
 * `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/petty-cash/`, in `floats.json`,
 * `vouchers.json` and `counter.json`. Nothing else is written anywhere: the journal and
 * the `expense_add` payload this server produces are handed back for whoever owns the
 * ledger and the expense book, and are never posted from here.
 *
 * NO BALANCE IS STORED. A float record holds its imprest, its top-ups and its counts, and
 * every balance is derived from those and the vouchers on the call. A stored balance is a
 * second copy of what the vouchers already decide, and the copy is the one that gets
 * believed after somebody deletes a voucher.
 *
 * Reads go through the timezone engine's `readJsonFile`, so a store that is not JSON is
 * quarantined byte-for-byte as `<file>.corrupt-<timestamp>` with a `.corrupt` marker
 * beside it, and every later call fails loudly instead of reading a float that is still
 * on disk as "no vouchers" and reporting a tin that balances.
 */

export function dataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const dir = join(base, "mcp-servers", "petty-cash");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function lockPath(): string { return join(dataDir(), ".lock"); }

function read<T>(file: string, empty: T): T {
  return readJsonFile<T>(join(dataDir(), file), empty);
}

/** Atomic: per-process temp name, then rename over the target. */
function write(file: string, value: unknown): void {
  const p = join(dataDir(), file);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, p);
}

export function getFloats(): Float[] { return read<Float[]>("floats.json", []); }
export function setFloats(v: Float[]): void { write("floats.json", v); }
export function getVouchers(): Voucher[] { return read<Voucher[]>("vouchers.json", []); }
export function setVouchers(v: Voucher[]): void { write("vouchers.json", v); }

/**
 * Allocate the next id in a series: `<PREFIX>-<YYYY>-<NNNN>`.
 *
 * The counter is per prefix and per year and is written BEFORE the record is stored, so a
 * crash burns a number rather than reusing one. Ids already in the store are also scanned,
 * so a restored or hand-edited store cannot reissue a number that is already written on a
 * paper voucher in the tin.
 */
export function nextId(prefix: "FLOAT" | "VOU", year: string, existing: string[]): string {
  const counters = read<Record<string, number>>("counter.json", {});
  const key = `${prefix}-${year}`;
  let n = counters[key] ?? 0;
  const used = new Set(existing);
  do { n += 1; } while (used.has(`${key}-${String(n).padStart(4, "0")}`));
  counters[key] = n;
  write("counter.json", counters);
  return `${key}-${String(n).padStart(4, "0")}`;
}

/**
 * Resolve a float by exact id (case-insensitive), then by exact name, then -- only if
 * nothing exact matched -- by partial name. More than one partial candidate is refused
 * with the list rather than silently picking the first, so a voucher cannot be booked
 * against the wrong tin.
 */
export function findFloat(list: Float[], ref: string): Float | undefined {
  const needle = String(ref).trim().toLowerCase();
  const byId = list.find((f) => f.id.toLowerCase() === needle);
  if (byId) return byId;
  const exact = list.filter((f) => f.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const pool = exact.length ? exact : list.filter((f) => f.name.toLowerCase().includes(needle));
  if (pool.length > 1) {
    throw new Error(`"${ref}" matches more than one float: ${pool.map((f) => `${f.id} (${f.name})`).join(", ")}. Pass the exact id.`);
  }
  return pool[0];
}

/** The one float on the free tier, or the named one. A single float needs no name. */
export function resolveFloat(list: Float[], ref?: string): Float {
  if (!list.length) throw new Error("there is no float yet. Run float_open with a name, a currency and the imprest amount in minor units first.");
  if (!ref) {
    if (list.length === 1) return list[0];
    throw new Error(`there are ${list.length} floats (${list.map((f) => `${f.id} (${f.name})`).join(", ")}). Name the one you mean.`);
  }
  const f = findFloat(list, ref);
  if (!f) throw new Error(`no float matches "${ref}". Known: ${list.map((x) => `${x.id} (${x.name})`).join(", ") || "none"}.`);
  return f;
}
