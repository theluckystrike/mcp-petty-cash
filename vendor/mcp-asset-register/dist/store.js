import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "@theluckystrike/mcp-timezone/lib";
export function dataDir() {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    const dir = join(base, "mcp-servers", "asset-register");
    mkdirSync(dir, { recursive: true });
    return dir;
}
export function lockPath() { return join(dataDir(), ".lock"); }
function read(file, empty) {
    return readJsonFile(join(dataDir(), file), empty);
}
/** Atomic: per-process temp name, then rename over the target. */
function write(file, value) {
    const p = join(dataDir(), file);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, p);
}
export function getAssets() { return read("assets.json", []); }
export function setAssets(v) { write("assets.json", v); }
/**
 * Allocate the next asset id: `ASSET-<YYYY>-<NNNN>`.
 *
 * The counter is per year and is written BEFORE the asset is stored, so a crash burns an
 * id rather than reusing one. Ids already in the store are also scanned, so a restored or
 * hand-edited register cannot reissue a number that is already on a filed fixed asset
 * schedule.
 */
export function nextAssetId(year, existing) {
    const counters = read("counter.json", {});
    const key = `ASSET-${year}`;
    let n = counters[key] ?? 0;
    const used = new Set(existing);
    do {
        n += 1;
    } while (used.has(`${key}-${String(n).padStart(4, "0")}`));
    counters[key] = n;
    write("counter.json", counters);
    return `${key}-${String(n).padStart(4, "0")}`;
}
/**
 * Resolve an asset by exact id (case-insensitive), then by exact name, then -- only if
 * nothing exact matched -- by partial name. More than one partial candidate is refused
 * with the list rather than silently picking the first, so a disposal cannot be booked
 * against the wrong machine.
 */
export function findAsset(list, ref) {
    const needle = String(ref).trim().toLowerCase();
    const byId = list.find((a) => a.id.toLowerCase() === needle);
    if (byId)
        return byId;
    const exact = list.filter((a) => a.name.toLowerCase() === needle);
    if (exact.length === 1)
        return exact[0];
    const pool = exact.length ? exact : list.filter((a) => a.name.toLowerCase().includes(needle));
    if (pool.length > 1) {
        throw new Error(`"${ref}" matches more than one asset: ${pool.map((a) => `${a.id} (${a.name})`).join(", ")}. Pass the exact id.`);
    }
    return pool[0];
}
