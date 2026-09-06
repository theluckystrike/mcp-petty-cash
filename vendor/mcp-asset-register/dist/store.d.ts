import type { Method } from "./depreciation.js";
import type { SchemeId } from "./tables.js";
/**
 * Assets live in this server's OWN data directory,
 * `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/asset-register/`. Nothing else is
 * written: the expense ledger belongs to servers/expense-tracker and this server never
 * reaches into it (see `asset_journal` and README.md for why).
 *
 * Reads go through the timezone engine's `readJsonFile`, so a store that is not JSON is
 * quarantined byte-for-byte as `<file>.corrupt-<timestamp>` with a `.corrupt` marker
 * beside it, and every later call fails loudly instead of treating a register that is
 * still on disk as "no assets" and depreciating nothing.
 */
export interface Disposal {
    date: string;
    proceeds_minor: number;
    accumulated_minor: number;
    nbv_minor: number;
    result_minor: number;
    result: "gain" | "loss" | "break-even";
    note?: string;
}
export interface Asset {
    /** `ASSET-<YYYY>-<NNNN>`, allocated per year of the in-service date. */
    id: string;
    name: string;
    scheme: SchemeId;
    category: string;
    category_name: string;
    cost_minor: number;
    currency: string;
    residual_minor: number;
    purchase_date: string;
    in_service_date: string;
    method: Method;
    life_years: number;
    life_source: string;
    rate_pct: number;
    declining_coefficient?: number;
    life_override?: number;
    rate_override?: number;
    project?: string;
    note?: string;
    disposal?: Disposal;
    /**
     * The months `asset_journal` has already produced a line for, as `YYYY-MM`, ascending.
     *
     * The journal writes nothing into the expense ledger, but it does leave this mark on
     * the register, because without it "has anything downstream been posted for this asset"
     * is unanswerable and `asset_delete` would have to either refuse everything or delete
     * the cost behind a figure that is already in someone's books.
     */
    journaled?: string[];
    created: string;
    updated: string;
}
export declare function dataDir(): string;
export declare function lockPath(): string;
export declare function getAssets(): Asset[];
export declare function setAssets(v: Asset[]): void;
/**
 * Allocate the next asset id: `ASSET-<YYYY>-<NNNN>`.
 *
 * The counter is per year and is written BEFORE the asset is stored, so a crash burns an
 * id rather than reusing one. Ids already in the store are also scanned, so a restored or
 * hand-edited register cannot reissue a number that is already on a filed fixed asset
 * schedule.
 */
export declare function nextAssetId(year: string, existing: string[]): string;
/**
 * Resolve an asset by exact id (case-insensitive), then by exact name, then -- only if
 * nothing exact matched -- by partial name. More than one partial candidate is refused
 * with the list rather than silently picking the first, so a disposal cannot be booked
 * against the wrong machine.
 */
export declare function findAsset(list: Asset[], ref: string): Asset | undefined;
