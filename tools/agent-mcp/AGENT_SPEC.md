# GateLab agent interface — the specification an agent reads

This is the manual for an agent that gates through a GateLab tab. The `gatelab_guide` tool returns it; read it once before the first gate. The tool descriptions repeat the essentials; this document is the whole contract. It applies to GateLab in the browser (FCS files) and to GateLabR (a SingleCellExperiment served from R) alike; section 9 has what differs.

## 1. What this is

GateLab is a gating tool for flow and mass cytometry. The gating engine is the open tab: it holds the events, evaluates gates, and draws. An agent does not get a copy of the data. It sends requests to the tab through a relay on the user's computer, and the tab answers from its own state and applies changes through its own reducer. So every gate the agent makes appears in the user's tab at once, as an ordinary gate with a badge saying who made it and a tooltip with the rationale; the user can move, rename, edit or undo it like any other, and the agent sees the user's own changes the next time it asks.

The agent cannot save. "Save to SCE" in GateLabR and the workspace save in the browser app are the user's. `gatelab_export` writes a file of the current gating for another process to read; it is not a save.

## 2. Connecting

- The relay is an MCP server (`tools/agent-mcp/server.mjs`) that listens for one tab on `ws://127.0.0.1:<port>/?token=<token>` (port 48123 by default). It is reachable only from this computer and admits only a tab that carries the token. One tab at a time: a second connection replaces the first.
- The relay writes its address to `~/.gatelab/agent-relay.json` (`{token, port, url, savedAt}`) when it starts, so a launcher can find it and so the address stays the same from one session to the next.
- The browser app connects through the header's **Agent** menu: *Connect to an agent…*, paste the address (`gatelab_status` returns it). The menu then shows "Agent · connected" and counts requests; *Disconnect* cuts the agent off. A page opened with `?agent=<URL-encoded address>` connects on load.
- GateLabR connects on launch: `launchGatingApp(sce, agent = TRUE)` reads the relay file and opens the tab with `?agent=`; `agent = "ws://…"` gives the address directly.
- `gatelab_status` says whether a tab is connected, which app and host it is (`{app, version, host: "browser" | "sce", workspaceName}`) and the current revision. Call it first; every other tool fails with `failed: no tab` until a tab is connected.

## 3. The gating as the agent sees it

`gatelab_describe` returns everything below, in one reply. Call it first and again after the user changes something (a `changed` event, section 7).

- **revision** — an integer that moves on every change, by the user or by a command. Pass it as `expectedRevision` to `gatelab_apply` to be refused when the gating moved meanwhile.
- **host** — `{app, version, host, workspaceName}`.
- **channels** — one per channel: `key` (the name every other tool and command uses), `label`, `pnn` ($PnN), `marker`, `kind` (`scatter` | `fluorescence` | `cytof` | `other`) and `transform`, the display transform the axis is drawn with (for example `{kind: "asinh", cofactor: 5}` on a mass cytometry channel; `linear`, `logicle` or `biex` on flow).
- **samples** — one per file or SCE sample: `id`, `name`, `events`, `viewed` (the one on the plot), `checked` (ticked in the file list: pooled and taken by the other tabs), and `metadata`, the Metadata tab's columns for this sample (an SCE's colData that is constant within the sample, for example `condition`, `batch`).
- **rootPopulationId** and **populations** — the tree in display order. Each population: `id`, `name`, `parentId`, `depth`, `gates` (`[{gateId, include, quadrant?}]`: the population is the AND of these, a gate with `include: false` excluded, `quadrant` 0–3 for one corner of a quadrant gate), `counts` per sample (`{sampleId, n, parentN, percentOfParent}`) and `pooled` (`{n, parentN, percentOfParent, percentOfTotal}` over every sample).
- **gates** — each: `id`, `name`, `type` (`rectangle` | `polygon` | `quadrant` | `ellipse`), `x`, `y` (channel keys), `space` (`display` | `raw` | null for a gate saved without one), `transforms` where the gate records them, and its geometry in its own space: `vertices` (a rectangle is two opposite corners; a polygon its vertices in order), `bounds` for a rectangle (`half-open`: an event on the upper edge of either axis is outside; `closed`), `center` for a quadrant (the crosshair), `ellipse` (`{mean, covariance, distanceSquare}`), `color`, and `provenance` (`{by, rationale, at}`) on gates an agent made.
- **view** — `{populationId, sampleId, x, y, tab, ranges: {x: [lo, hi] | null, y: …}}`: what the user's Gating plot shows, with the axis ranges in display units.

Populations are addressed by `id`, gates by `id`, channels by `key`, samples by `id`. Names are for people; two populations may share a name.

## 4. Coordinate spaces and units

- **display** — the axes as drawn: each channel through its `transform`. A mass cytometry channel at cofactor 5 reads about 0 to 8; a flow channel on a logicle or biex reads on that scale. This is the space `gatelab_distribution`, `gatelab_stats` and `view.ranges` report, and the space to gate in unless there is a reason not to.
- **raw** — the stored values (the FCS data as compensated, or the SCE assay as served).
- Every command names its `space`; a gate drawn in display space is straight on the plot. A gate is evaluated on the events in its own space, so it does not move when the user changes a display transform.
- **The edge of the data** — for a range, a `null` bound means the edge of the data on that side: the extreme value over every loaded sample, 2% of the span past it, and the gate is closed there. A range never has an infinite edge; an unbounded edge would be drawn far off the chart (at asinh(1e12/5) ≈ 26.7 on a cytof axis) and the Fit button would follow it.

## 5. Reading

**gatelab_distribution** `{x, y?, bins?, range?, populationId?, sampleIds?, pooled?}` — where a population's events lie on one channel or two, in display units.
- Series: one per sample (`series` = the sample id), or one `"pooled"` series over the chosen samples. Without `sampleIds`: the viewed sample, or the checked samples when `pooled`.
- Per series: `n` (events read, finite on the axes asked), `dropped` (not finite, so not counted), and per axis `{channel, transform, min, max, edges, counts, quantiles, mean, valleys}`: `bins + 1` edges from the range's low to its high (64 bins when absent, 2 to 256), the counts per bin, quantiles keyed by probability as a string (`"0.01"`, `"0.05"`, `"0.1"`, `"0.25"`, `"0.5"`, `"0.75"`, `"0.9"`, `"0.95"`, `"0.99"`), the mean, and `valleys`: the antimodes of the histogram after a three-bin smoothing, with a mode on either side, deepest first, at most three — where a threshold between two populations goes. Empty for one mode.
- With `y`: also `grid`, `bins × bins` counts, row-major by y bin then x bin: `grid[yi * bins + xi]`.
- `range` fixes the axes (`{x: [lo, hi], y: [lo, hi]}`) so series compare bin for bin; otherwise each series spans its own data.

**gatelab_stats** `{populationIds?, channels?, thresholds?, populationId?, sampleIds?, pooled?}` — per population and series: `n`, `medians` per channel in display units (null where no event is finite), and with `thresholds` (`{channelKey: value}` in display units) `positive`, the fraction of the population at or above each threshold, 0 to 1. Over more than 200,000 events the medians and fractions are read on every k-th event and `sampled` is true; `n` is still the full count.

**gatelab_view** `{populationId?, sampleId?, x?, y?, fit?, xRange?, yRange?}` — sets the user's Gating plot: the population, the sample and the two channels, then the axes. `fit: true` fits them as the Fit button does (the viewed file's 0.1st to 99.9th percentiles, widened to the gates on those channels) — note that this drops the pile at zero of an arcsinh axis. `fit: "data"` fits them to every event of every sample, 2% past the last, widened to the gates, so nothing is cut off. `xRange` / `yRange` hold an axis at a range in display units (as the Scales tab's Min/Max does), applied after any fit. The reply is the view with the `ranges` now shown. The view is the user's too: setting it moves their plot.

**gatelab_render** `{width?}` — a PNG of the Gating plot as the user sees it: the events of the active population, the current axes, the gates on those channels. Set the view first. The reply carries the view and the pixel size.

**gatelab_wait_for_change** `{timeoutSeconds?}` — waits for the next change the user makes (or the timeout, 60 s by default; null then) and returns the new revision.

Two more methods reach the tab through `gatelab_export` rather than tools of their own: **workspace** (the workspace JSON as the app saves it, without the data) and **memberships** (per population, one packed bit mask per sample, least significant bit first, as the colData export packs them).

## 6. Changing the gating

Every change is a **command**, previewed with `gatelab_preview {command}` and done with `gatelab_apply {command, rationale, expectedRevision?}`. The preview returns every population's counts as they would be afterwards, the new ones marked `isNew`, and the gates; nothing changes. Apply returns the populations and gates afterwards and `created: {gateIds, populationIds}`. The `rationale` is required: it is written on every gate the command creates and shown to the user in the badge's tooltip, so say why in one or two sentences a cytometrist would accept.

A command that fails a check is refused as a whole — nothing changes — with a message saying what was wrong. Coordinates are in the command's `space`.

| command | fields | what it makes | refused when |
|---|---|---|---|
| `createGate` | `shape: "rectangle" \| "polygon"`, `name`, `parentId`, `x`, `y`, `space`, `vertices: [[x, y], …]` | A gate and a population of that gate under the parent. A rectangle is two opposite corners (drawn half-open: an event on its upper edge is outside). | A rectangle not two corners or with zero width or height; a polygon with fewer than 3 or more than 128 vertices, a repeated vertex, zero area, an edge crossing another, or a non-finite coordinate. |
| `createRange` | `name`, `parentId`, `x`, `y`, `space`, `xBounds: [lo \| null, hi \| null]`, `yBounds: [lo \| null, hi \| null]` | A rectangle from thresholds, closed on every side: a marker-positive gate is `xBounds: [t, null], yBounds: [null, null]`; a two-marker gate `[t1, null], [t2, null]`; a negative gate `[null, t]`. `null` is the edge of the data on that side (section 4). | Both bounds null on both axes; `lo >= hi`; a non-finite number. |
| `createQuadrant` | `name`, `parentId`, `x`, `y`, `space`, `center: [x, y]`, `names?: [Q1, Q2, Q3, Q4]` | A quadrant gate at the crosshair and four populations under the parent, **Q1 = x− y+ (upper left), Q2 = x+ y+ (upper right), Q3 = x+ y− (lower right), Q4 = x− y− (lower left)**, so for `x: "EOMES", y: "T-bet"` the names run EOMES−T-bet+, EOMES+T-bet+, EOMES+T-bet−, EOMES−T-bet−. Without `names` they are built from `name` and the axes. | `names` not exactly four strings. |
| `createEllipse` | `name`, `parentId`, `x`, `y`, `space`, `center: [x, y]`, `radii: [rx, ry]` | An axis-aligned ellipse of those semi-axes (in the command's space) and its population. For a density-following ellipse take the mean and SD of the cells from a 2-D distribution and use a multiple of the SDs. | A radius not positive. |
| `definePopulation` | `name`, `parentId`, `gates: [{gateId, include}]` | A population from gates already drawn: the AND of them, a NOT for `include: false`. | No gates; `include` not boolean; an unknown gate. |
| `editGate` | `gateId`, `vertices` | Replaces a rectangle's corners or a polygon's vertices in the gate's own space; the population is re-evaluated. Prefer it to delete-and-redraw. | As `createGate`'s vertex checks; a quadrant or ellipse. |
| `moveQuadrantCenter` | `gateId`, `center` | Moves a quadrant's crosshair. | Not a quadrant. |
| `renameGate` / `renamePopulation` | `gateId` \| `populationId`, `name` | Renames. | Empty name; unknown id. |
| `movePopulation` | `populationId`, `targetId`, `placement: "inside" \| "before" \| "after"` | Moves a population under or beside another, with its subtree. | The root; onto itself; unknown ids. |
| `deleteGate` | `gateId` | Removes the gate. **Its population stays, now ungated (100% of its parent).** | Unknown gate. |
| `deletePopulation` | `populationId` | Removes the population; its children move up to its parent; its gates stay. This is the command for a population you no longer want. | The root. |
| `undo` / `redo` | — | The app's own undo and redo, over the user's changes and yours alike. | Nothing to undo or redo. |

Also refused everywhere: an unknown `parentId`, an unknown channel key, `x` and `y` the same channel, a `space` other than `"raw"` or `"display"`.

Conventions that are not checked but matter:
- **Orientation.** A gate is drawn only on plots whose x and y are its own, so put `x` and `y` the way the user's gates on those channels have them (read them from describe). A readout marker goes on y and is left unbounded (`yBounds: [null, null]`), so the gate selects on x alone and the plot shows the readout.
- **Names.** Name a population for what it holds (`CD45RO+CD62L+`, `EOMES+ T-bet−`), add a short suffix that marks it as yours when it sits beside the user's version of the same gate, and never rename or delete the user's gates and populations; make yours beside theirs and say in the rationale how they differ.
- **Parents.** A gate's population lives under `parentId` and counts against it; nest a threshold under the population it refines rather than redrawing the parent's cut.

## 7. What the user sees and does

- Every gate the agent makes carries `provenance {by, rationale, at}`; the tab shows the badge with `by` (the relay's `--writer` name) on the gate card and the rationale in its tooltip.
- The user may edit, move, rename, undo or delete anything, including the agent's gates, at any time. The tab sends a `changed` event with the new revision after every change, the user's or the agent's; the relay keeps the latest revision (`gatelab_status`) and `gatelab_wait_for_change` returns when it moves. After a change, call `gatelab_describe` again before building on ids or counts.
- `gatelab_view` moves the user's plot. Use it to show them what you are looking at, and put it back on their population when you are done.
- The user alone saves. In GateLabR an autosave keeps the gates in the SCE after every change, but the memberships the R readers need are stored only by the user's "Save to SCE"; say so when a result is ready to be read in R.

## 8. Rules of good gating with these tools

1. **Look before you gate.** `gatelab_distribution` on the channel, pooled and per sample; the `valleys` are where a threshold goes, and the quantiles say where the bulk lies. `gatelab_stats` with `thresholds` gives the fraction positive the cut would call.
2. **Preview, then apply with a rationale.** Tune the boundary on the preview's counts; the rationale is what the user reads.
3. **Check per sample, not only pooled.** A threshold that fits the pool can miss a file whose staining sits elsewhere; `gatelab_distribution` with `sampleIds` shows each file's own valleys, and `samples[].metadata` says which files belong together (condition, batch). Report the files a gate serves badly instead of widening it until it serves none well.
4. **Look at what you drew.** `gatelab_view` with the population and axes, then `gatelab_render`. If the data is cut off at an edge, `fit: "data"` (the Fit button's frame drops the pile at zero of an arcsinh axis), or `xRange` / `yRange`.
5. **Never an open edge.** A range's null bound is the data's edge; a polygon has no open edges at all. Do not put a vertex at a huge value to mean "unbounded".
6. **A hull takes the tail with it.** A convex hull around a density bulges, so on a cloud with a tail toward an axis (PD-1-negative cells along PD-1 = 0) cut the tail at its valley before taking the hull, or the "high" gate holds the low cells too. Check with `gatelab_stats` and a threshold.
7. **Keep the tree tidy.** `deleteGate` leaves its population ungated; `deletePopulation` is the command for a population you no longer want. Edit a gate in place rather than delete and redraw, so the user's adjustments and the provenance survive.
8. **Name parents and gates by id**, from the latest describe. Ids are stable across the session; names are not unique.
9. **State the numbers you got.** A gate is a claim: report the pooled count and percent of parent, the per-sample range, and the marker medians that justify it, in display units, with the threshold values.

## 9. GateLabR: the SCE host

- `launchGatingApp(sce, agent = TRUE)` opens the tab connected (section 2). `host` is `"sce"`; sample ids are `sce-<object name>:sample-<i>` (i from 0); sample names come from the sample column (`sample_id` by default); `samples[].metadata` is the colData constant within each sample.
- Channel keys are the object's marker names (rownames, or the `marker` rowData column): `CD4`, `EOMES`, `T-bet`. `pnn` is the metal (`Cd111Di`).
- The app draws the SCE's display assay (`exprs`, arcsinh at the recorded cofactor, 5 when none is recorded) as stored, so display units are the assay's own values; `counts` is linear and drawn through the arcsinh transform. The header's assay menu is the user's.
- **Autosave vs Save to SCE.** After every change the host writes the workspace (the gates) into `metadata(sce)$gatelab_workspace` of the object in the user's R session. The population memberships that `gatelabPopulations()`, `gatelabLeafPopulation()` and `gatelabHierarchy()` read are written only when the user presses **Save to SCE**; until then those readers refuse the object as holding none, or stale ones. The agent cannot press it.
- With Shiny 1.14 the launch returns at once and the user's R prompt is free while the tab is open; the app is serviced while R is idle, so a long computation at the prompt pauses it. `gatelabStop()` stops the app. If the user rebinds the object at the prompt (`sce$x <- …`), the app refuses its next save until `gatelabSync("sce")` hands it the console's object; nothing the agent does changes this.
- Reinstalling GateLabR while the user's R session has it loaded corrupts the loaded package (the next autosave fails with "lazy-load database is corrupt"). Export the gating first (`gatelab_export`), have the user stop the app and restart R, then relaunch; after a reinstall of the core alone, `gatelab_reload` brings the open tab onto the new core.

## 10. Errors and limits

- Errors come back as `code: message`. `refused`: the command failed a check, nothing changed. `conflict`: `expectedRevision` is behind; the message carries the current revision — describe again. `failed`: the tab could not do it (no tab connected, a render that did not finish). `unknown-method`: the tab's core predates the method; reload it.
- One tab; one request at a time per tab (the relay queues them). A polygon has at most 128 vertices. Bins are 2 to 256 per axis. Stats over 200,000 events are sampled. A render is at most 4000 px wide.
- Counts in `describe` are exact; `n` in distributions and stats excludes events not finite on the axes read.

## 11. The export file

`gatelab_export {path, populationIds?}` writes `{format: "gatelab-agent-export", version: 1, exportedAt, tab, revision, workspace, samples, populations}` where `workspace` is the app's workspace JSON (the gates and the tree, as the app saves it), `samples` are as in describe, and each population is `{id, name, hierarchyId, sampleMasks: [{sampleId, eventCount, membershipBitsBase64}]}`, the bits least significant first in the sample's event order. Give it an absolute path outside synced folders (not Google Drive). It is a record for another process; the user's workspace and SCE are untouched.

## 12. A worked sequence

```
gatelab_status                                   → connected, host "sce", revision 2
gatelab_describe                                 → ids: root R, the user's "CD45RO+CD62L+" P1; channels CD62L, CD45RO, EOMES…
gatelab_distribution {x: "CD62L", populationId: R, pooled: true}         → valleys [1.3]
gatelab_distribution {x: "CD45RO", populationId: R, pooled: true}        → valleys [2.2]
gatelab_preview {command: {type: "createRange", name: "CD45RO+CD62L+ (agent)", parentId: R,
                           x: "CD62L", y: "CD45RO", space: "display",
                           xBounds: [1.3, null], yBounds: [2.2, null]}}   → 591,207 (21.1% of R)
gatelab_apply {command: …, rationale: "Memory gate from the two marginal valleys …", expectedRevision: 2}
gatelab_distribution {x: "CD62L", populationId: R, sampleIds: […]}       → six samples with CD62L dim: report them
gatelab_view {populationId: R, x: "CD62L", y: "CD45RO", fit: "data"} ; gatelab_render
```
