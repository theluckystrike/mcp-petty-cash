# mcp-asset-register

Keep a fixed asset register and depreciate it on the rates the tax authorities actually publish. You give it what you bought, what it cost, when it went into use and which category it falls in; it gives you the rate, the useful life, the convention, the full schedule year by year or month by month, the monthly journal entry, and the gain or loss when you sell it. Three tables ship with it: the Polish annual depreciation rates from the annex to the CIT and PIT acts keyed to the KST classification, the UK capital allowance pools with the annual investment allowance, and the US MACRS GDS half-year tables for 3, 5 and 7 year property. The tables are bundled files, not a live feed, so the same asset depreciated twice gives the same answer, and every rate carries its instrument, its source URL and the date it took effect. Nothing leaves your machine.

Built by [theluckystrike](https://github.com/theluckystrike).

## Install

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "asset-register": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-asset-register"]
    }
  }
}
```

Claude Code:

```sh
claude mcp add asset-register -- npx -y @theluckystrike/mcp-asset-register
```

Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`): the same entry as Claude Desktop.

## Tools

| tool | what it does |
| --- | --- |
| `asset_add` | Add one asset to the register. The rate, the useful life and the convention come from the bundled table; both can be overridden. |
| `asset_list` | The register with cost, accumulated depreciation and net book value at a date, totalled per currency. |
| `asset_schedule` | The full schedule for a stored asset or for one you are only pricing, per year or per month, down to zero or the residual. |
| `asset_journal` | One month's journal: debit depreciation expense, credit accumulated depreciation, per asset and in total, plus an `expense_add` payload. |
| `asset_dispose` | Record a sale, a scrapping or a write-off and get the gain or loss against net book value at that date. |
| `asset_delete` | Remove an asset nothing depends on, and get its free-tier slot back. An asset that has been disposed of or journaled is refused, with the dependent named. |
| `asset_report` | Net book value by category and currency, the year's charge, and every disposal in the year with its result. |
| `license_status` | Free or Pro, and where to upgrade. |
| `license_activate` | Activate a Pro key. Verified offline. |

Read the `assets://categories` resource for every bundled category, its code, its rate and what each table leaves out.

## Free vs Pro

| | Free | Pro |
| --- | --- | --- |
| Assets in the register | 10 | Unlimited |
| `asset_schedule` | Yes, unlimited | Yes |
| `asset_list`, `asset_dispose`, `asset_delete` | Yes, unlimited | Yes |
| `asset_journal` | No | Yes |
| `asset_report` | No | Yes |

[Get Pro](https://mcp.zovo.one/buy/asset-register): $19 one-time, or $39 for the bundle.

## What is in the tables, and what is deliberately not

Every table under `src/tables/` carries a `header` with the authority, the instrument, the source URL, the date the rates took effect and the date they were read. The `assets://categories` resource returns those headers with the rates, so the provenance travels with the number.

The rule for what is in them: **a value that could not be stated with confidence from the public text was left out, not guessed.** A depreciation rate ends up on a tax return. A wrong one that looks authoritative is worse than an absent one, because an absent one is refused by name and you go and look it up.

| table | bundled | left out |
| --- | --- | --- |
| Poland, KST | 33 rows covering the annex positions this build could state with confidence: 0 percent (land, not depreciated at all), 1.5, 2.5, 4.5, 7, 10, 14, 20 and 30 percent, at the KST group and subgroup level, with the declining-balance eligibility of each | The **18 and 25 percent positions** of the annex. Their KST membership could not be stated with confidence, so no row claims them. Also every individual six-digit KST code: a taxpayer classifies the asset, this table carries the rate |
| UK, capital allowances | The main rate pool at 18 percent, the special rate pool at 6 percent, and the annual investment allowance as a 100 percent first-year row with its GBP 1,000,000 cap | The first-year and full-expensing rules, the structures and buildings allowance, the small pools allowance, the CO2 thresholds that decide which pool a car enters, and every balancing charge. All date-sensitive, none stated with confidence here |
| US, MACRS | The 3, 5 and 7 year GDS classes under the **half-year convention**, as the published Pub 946 Table A-1 percentages | The mid-quarter and mid-month conventions, the 27.5 and 39 year real property classes, the 10, 15 and 20 year classes, the Alternative Depreciation System, section 179 and bonus depreciation. A 10-year class is refused by name, not approximated to the 7-year one |

Rates change. Check the `effective_date` in any answer before you rely on it, and read the `source_url` if the purchase is recent.

## Rules the engine applies

- **Poland charges from the month AFTER the asset enters the register** (art. 16h ust. 1 pkt 1). An asset in service on 15 March starts on 1 April, so year one is nine twelfths of the annual rate and the schedule runs one calendar year longer than the life suggests. Every answer names the first charge month.
- **The Polish declining-balance method switches** (art. 16k). The rate is multiplied by a coefficient of up to 2.0 on the written-down value, and in the first year the declining amount would fall below the straight-line amount, the rest of the schedule is straight line. Passenger cars (KST 741) and buildings are excluded from the method entirely and are refused rather than quietly computed.
- **A UK writing down allowance is a pool rate, not a per-asset charge.** This server applies it to one asset so a per-asset figure exists, and says so in every answer. A pure reducing balance never reaches zero, so the schedule is cut at 25 periods and the last one writes off what is left, with the basis line saying that is what happened.
- **MACRS ignores salvage value.** The published percentages recover the whole cost. A residual passed for a US asset is reported back as ignored and kept on the record for book purposes, rather than silently reducing the base.
- **The periods sum to the depreciable base, to the minor unit.** Money is integer minor units end to end and the schedule is allocated by cumulative rounding, so `sum(periods) == cost - residual` holds for every input, and the monthly rows sum to their year.
- **A byte-identical asset is refused, not stored twice.** `asset_add` normalises the name, the category, the cost, the currency, the dates, the method, the life, the scheme and the salvage value, and a record that matches an asset already on the register is refused by that asset's id with nothing written. A retried call and a re-run script look exactly like a second machine, and on a ten-asset free tier the second row is a slot you cannot get back. Two genuinely identical units are a legitimate register: give the second one a distinguishing name and it is accepted.
- **`asset_delete` is the way back, and it is free.** It removes an asset nothing depends on. A recorded disposal or a month `asset_journal` has already journaled is a dependent, and the delete is refused with that dependent named rather than removing the cost behind a figure that has already left this server. The id is never reissued.
- **Depreciation is charged up to and including the month of disposal**, then stops. The gain or loss is proceeds less net book value at that month, and the disposal journal balances to zero.
- **Currencies are never added together.** There is no exchange rate in this server, so a PLN register and a USD one stay two figures.

## Posting to the expense tracker

`asset_journal` returns the exact `expense_add` arguments for the [expense-tracker](../expense-tracker) server, one payload per currency, and writes no expense itself. That is deliberate: expense-tracker publishes no library entry point, and its id counter, its category rules, its VAT split and its currency defaults all live inside its own `expense_add` handler under its own lock. Appending a row to its `data.json` directly would produce an entry with none of those applied: one that looks native and is not. Handing back the arguments is the same contract [per-diem](../per-diem) and [kanban](../kanban) use. It does mark the register: each asset it produced a line for records the month, so `asset_delete` can refuse an asset whose depreciation has already been journaled instead of deleting the cost behind a posted figure.

No `vat_rate` is set on the payload. Depreciation is a book charge, not a purchase, so there is no input VAT on it.

## A measured insight

**The yearly schedule is where you look for rounding errors, and the monthly journal is where they actually are.**

Of the 67 schedules these three tables can produce for one test asset (cost 12,345.67, residual 45.67, in service 12 March 2026), the yearly rows come out clean under almost any rounding rule, because an annual amount is a percentage of a base and lands on or near a whole cent. Split those same years into months by rounding each month independently and **35 of the 67 no longer sum to the depreciable base**, off by up to **390 minor units, 3.90 on a 12,345.67 asset**. The worst offenders are the longest-lived rows: a residential building at 1.5 percent spreads its base over 800 months, and 800 half-cent roundings is where the 3.90 comes from.

That is the wrong way round from the intuition. The monthly split feels like the harmless presentational step, the one after the real arithmetic has been done, so it is the step that gets a bare `Math.round` and no test. It is also the only step whose output is posted: nobody journals a year, they journal a month, so the number that reaches the ledger is the one from the step that was not checked. The fix is that `allocate` rounds the CUMULATIVE total at each step and takes each amount as the difference between two rounded cumulatives, with the last period set to whatever is left, and it is applied to the monthly split as well as the yearly one. `test/contract.test.mjs` then asserts the identity for every schedule the tables can produce rather than for the two or three a unit test would have picked.

## Privacy

Everything stays on your machine. Assets are JSON under `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/asset-register/`. The rate tables are files inside the package. There is no network call anywhere in this server, no account and no API key. License keys are verified offline.

## License

MIT. Support: support@zovo.one
