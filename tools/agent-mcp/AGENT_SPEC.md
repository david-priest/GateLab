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
- **rootPopulationId** and **populations** — the tree in display order. Each population: `id`, `name`, `parentId`, `depth`, `gates` (`[{gateId, include, quadrant?}]`: the population is the AND of these, a gate with `include: false` excluded, `quadrant` 1–4 for one corner of a quadrant gate (1 = upper left, 2 = upper right, 3 = lower right, 4 = lower left; the positive side includes the crosshair)), `counts` per sample (`{sampleId, n, parentN, percentOfParent}`) and `pooled` (`{n, parentN, percentOfParent, percentOfTotal}` over every sample). A population is not evaluated for a sample whose own tree (a tailored or group copy whose structure was unlocked and changed) has no counterpart for it: that sample's count has `n` and `percentOfParent` null and a `notEvaluated` note naming the file and its tree, and it is left out of `pooled`, as the Statistics tab shows it. Report it as not evaluated, never as 0.
- **gates** — each: `id`, `name`, `type` (`rectangle` | `polygon` | `quadrant` | `ellipse`), `x`, `y` (channel keys), `space` (`display` | `raw` | null for a gate saved without one), `transforms` where the gate records them, and its geometry in its own space: `vertices` (a rectangle is two opposite corners; a polygon its vertices in order), `bounds` for a rectangle (`half-open`: an event on the upper edge of either axis is outside; `closed`), `center` for a quadrant (the crosshair) and, for a spider quadrant, `arms` (`{down, right, up, left}`, the ends of its four arms on the edges of the box they span; each quadrant is the polygon of the centre, its two arm ends and the box corner between them, and an event outside the box is in none), `ellipse` (`{mean, covariance, distanceSquare}`), `color`, and `provenance` (`{by, rationale, at, source}`) on gates a command or a strategy proposal made (section 16): `source` is `agent` for yours, or the source of a proposal the user accepted in the tab; a gate made before sources were recorded has none.
- **view** — `{populationId, sampleId, x, y, tab, ranges: {x: [lo, hi] | null, y: …}, strategy}`: what the user's Gating plot shows, with the axis ranges in display units, the tab on screen, and `strategy`, what the Strategy tab draws as its controls hold it (`{mode: "single" | "multi", populationIds, fullPath}`; null until the tab has been opened or a workspace restored it).

Populations are addressed by `id`, gates by `id`, channels by `key`, samples by `id`. Names are for people; two populations may share a name.

Gate geometry is the solid version on the viewed file, under the shared gate's canonical ID. `editing` reports its `owner` and next edit `target` (`kind`, `hierarchyId`, `gateId`, optional `name`) and whether the target is pending. Geometry edits follow the same file/group tailoring controls as a manual drag. In a pooled plot they edit the clicked file's solid version; population counts still cover all loaded samples as described above. Preview predicts those owner-specific memberships without consuming a pending target. Apply consumes it and remains one Undo step. Creation, names, deletion and population structure retain their existing tree semantics.

A changed geometry owner or pending edit target also advances the revision. If the viewed file changes from a tailored version to the shared gate between preview and apply, the old `expectedRevision` is refused. Ordinary navigation between files sharing the same owner and target leaves the revision unchanged. Describe again after changing the intended edit target.

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

**gatelab_stats** `{populationIds?, channels?, thresholds?, populationId?, sampleIds?, pooled?}` — per population and series: `n`, `medians` per channel in display units (null where no event is finite), and with `thresholds` (`{channelKey: value}` in display units) `positive`, the fraction of the population at or above each threshold, 0 to 1. Over more than 200,000 events the medians and fractions are read on every k-th event and `sampled` is true; `n` is still the full count. In both tools a series that includes a sample the population is not evaluated for carries `notEvaluated`, one note per such sample, and reads none of its events.

**gatelab_view** `{populationId?, sampleId?, x?, y?, fit?, xRange?, yRange?}` — sets the user's Gating plot: the population, the sample and the two channels, then the axes. `fit: true` fits them as the Fit button does (the viewed file's 0.1st to 99.9th percentiles, widened to the gates on those channels) — note that this drops the pile at zero of an arcsinh axis. `fit: "data"` fits them to every event of every sample, 2% past the last, widened to the gates, so nothing is cut off. `xRange` / `yRange` hold an axis at a range in display units (as the Scales tab's Min/Max does), applied after any fit. The reply is the view with the `ranges` now shown. The view is the user's too: setting it moves their plot.

**gatelab_view** with `strategy` `{populationIds, mode?, fullPath?}` (and `tab: "strategy"`, the default when `strategy` is given) opens the user's Strategy tab on those populations, for them to inspect, export or print. One population is drawn as its gating path, a strip of plots (`mode: "single"`; `fullPath: true` takes every gate from the root rather than the population's own, and leaving it out keeps the tab's setting); several, or `mode: "multi"`, are drawn together in one grid laid out as the tree from the root. The ids are populations of the active tree from the latest describe, each once, not the root; a population of another tree is refused by name, since the tab draws the active one. `fullPath` with `mode: "multi"` is refused, and so are `x`, `y`, `fit`, `xRange` and `yRange`, which set the Gating plot. Only the tab's controls change: no gate, no selection in the tree, and the revision does not move, so an open gating search continues. The Strategy tab draws the viewed file, or the Gating tab's pool when the user has pooled the checked files; `sampleId` changes the viewed file. The reply's `strategy` is what the tab now holds; a tab that did not take the selection is `failed`, and a core from before this feature answers on the Gating tab, which the relay reports as `unknown-method`. `tab: "strategy"` without `strategy` opens the tab on what it last drew.

**gatelab_render** `{width?}` — a PNG of the plot on screen. On the Gating tab: the events of the active population, the current axes, the gates on those channels. On the Strategy tab: the strategy grid as its PNG, SVG and PDF exports compose it (every panel, the arrows, the title), once the tab has finished drawing; an empty grid is refused with the tab's own status line. Set the view first. The reply carries the view and the pixel size.

**gatelab_wait_for_change** `{timeoutSeconds?}` — waits for the next change the user makes (or the timeout, 60 s by default; null then) and returns the new revision.

Two more methods reach the tab through `gatelab_export` rather than tools of their own: **workspace** (the workspace JSON as the app saves it, without the data) and **memberships** (per population, one packed bit mask per sample, least significant bit first, as the colData export packs them; a sample the population is not evaluated for has no bits and a `notEvaluated` note).

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
| `moveQuadrantCenter` | `gateId`, `center` | Moves a quadrant's crosshair; a spider quadrant's arm ends stay where they are. | Not a quadrant; a spider quadrant's centre outside its box. |
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

- Every gate the agent makes carries `provenance {by, rationale, at, source: "agent"}`; the tab shows a badge naming the source on the gate card, `by` (the relay's `--writer` name) and the rationale in its tooltip, and the whole record under the badge.
- The user may edit, move, rename, undo or delete anything, including the agent's gates, at any time. The tab sends a `changed` event with the new revision after every change, the user's or the agent's; the relay keeps the latest revision (`gatelab_status`) and `gatelab_wait_for_change` returns when it moves. After a change, call `gatelab_describe` again before building on ids or counts.
- `gatelab_view` moves the user's plot, or opens their Strategy tab. Use it to show them what you are looking at, and put it back on their population when you are done. The Strategy tab's controls stay as you left them until the user changes them, and are written with the workspace at its next save (in GateLabR, its next autosave).
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
gatelab_view {strategy: {populationIds: [P1, <the new population>]}} ; gatelab_render   → both strategies in one grid, for the user to print
```

## 13. Context and reference-label feedback

`gatelab_context` reads the active population chain, channel transforms, sample metadata, assay binding and actual plot sample selection. Checked samples are not necessarily pooled: incompatible trees, panels or assay layers can be left out of the plot. `plotSelection` is the actual plot pool. `populationCountScope` remains all loaded samples. Older cores return null for unavailable assay and plot selection rather than guessing. `gateVisibility` names the selected and checked gates when available: selection can bring a sibling gate onto a branch-scoped plot.

`gatelab_evaluate {referencePath, populationIds, sampleIds, groupBy?, projectedPrevalence?}` reads the tab's cumulative membership masks without changing the workspace. Every sample must be named explicitly. Each population is scored over all events in those samples, including target cells lost at ancestors. Replies contain pooled and per-sample confusion counts, precision, recall, F1, false-positive rate, prevalence and abundance bias in percentage points. `groupBy` names a sample-metadata column for additional grouped results; missing grouping values are refused. `stages` and `perSampleStages` show target retention and losses from the root through each requested population. Counts are exact, not the plotted event cap or a balanced subsample. Undefined ratios are null. Unevaluated sample/population pairs are excluded with a reason, not scored as zero selections.

The reference file is local JSON. For example, a synthetic five-event sample whose second and third events are labelled positive has packed bits 00000110, encoded as `Bg==`:

```json
{
  "format": "gatelab-reference-masks",
  "version": 1,
  "label": "CD4_positive",
  "eventOrder": "as-loaded",
  "sampleManifestSha256": "COPY_FROM_GATELAB_CONTEXT",
  "sampleMasks": [
    {"sampleId": "D1", "eventCount": 5, "membershipBitsBase64": "Bg=="}
  ]
}
```

Bits are least significant first in each sample's loaded event order. The producer must derive them from the same event identities and order as the loaded data. The manifest hash covers ordered sample IDs/names/counts, channel keys/transforms and available assay binding; it does not prove within-sample event identity. Mask lengths, duplicate IDs, padding, manifest, revision and nested memberships are checked. The tool refuses feedback if the describe snapshot changes while memberships are read. A successful check cannot detect a same-length, silently reordered reference. Keep the original identity audit with the reference file.

Labels are supplied reference annotations, not evidence of biological correctness. State whether feedback uses training or validation samples, preserve their natural prevalence, and do not open final-test labels while developing proposals. `projectedPrevalence` optionally reports expected precision at a stated prevalence, assuming the measured sensitivity and false-positive rate remain unchanged; it is not a held-out measurement.

## 14. Optional local transport audit

Launch the server with `--audit /absolute/path/agent-calls.jsonl` to append a local request/response record. `--writer` names the gate writer; it is not a model identifier. Optional `--model` records a caller-declared model string with that limitation explicit; without it model identity is unknown. The session record includes the MCP version and SHA-256 hashes of the relay/tool sources and guide. The connected tab reports its own version; a core commit is not inferred from that version.

The audit includes command parameters, rationales, previews, returned IDs, revisions and feedback. It contains sample metadata and other tool outputs, so keep it in the approved local experiment record. Image pixels are replaced by a hash. An audit request is written before a tool starts. If response logging fails after an apply, the reply retains the operation result and warns to inspect state before retrying. Server tool calls are serialized, with or without auditing, so multi-request feedback cannot interleave with another tool's mutation. `gatelab_wait_for_change`, `gatelab_status` and `gatelab_guide` run beside that queue: a pending wait does not hold up other calls. Audit records supplement an experiment notebook; they do not replace its scientific provenance.

`gatelab_export` also records context and refuses an inconsistent workspace/membership snapshot. It remains a local export, not a Save to SCE operation.

## 15. Gating searches: population and cluster modes

The Agent menu's **Agent-assisted gating…** dialog explains both modes, prepares a request for the connected agent, and displays its target, progress and stopping state. It does not contain an LLM or automatically derive labels from an SCE.

- **Population mode** fits a known or user-described phenotype. Inspect distributions and explain marker choices and boundaries. No reference-concordance score is reported without labels.
- **Cluster mode** reconstructs explicit labels supplied as aligned local reference masks (section 13). These annotations are the optimization target, not biological ground truth. Fix training and validation samples before searching. With `groupBy`, grouping values must also be disjoint, so repeated acquisitions from one donor cannot cross the split. Final test samples belong in neither list.

`gatelab_fit_start` declares mode, target, budget (1–100 candidates), a new absolute `historyPath`, and `trainingSampleIds`. Cluster mode also requires `validationSampleIds` and `references: [{key, path}]`, using the reference format of section 13. The objective is the macro average across targets of `f1` (default), `precision` or `recall`, minus `complexityPenalty × distinct gates` (default zero), optionally subject to `minPrecision`. Choices cannot change during a session.

`gatelab_fit_candidate` takes a rationale, a complete list of steps from the unchanged baseline, and a target mapping: a strategy proposal (section 16). Each step is `{key, command}`. Later ID fields can use `@key.population` or `@key.gate` when a step created exactly one such object, and `@root` for the active tree's root. Quadrants create four populations and have no single-population alias. Target mappings name reference keys in cluster mode or descriptive keys in population mode. For example:

```json
{
  "rationale": "Keep the broad parent, then remove the double-low wedge.",
  "steps": [
    {"key":"parent", "command":{"type":"createGate","shape":"rectangle","name":"Parent","parentId":"ROOT_ID","x":"X","y":"Y","space":"display","vertices":[[0,0],[6,6]]}},
    {"key":"child", "command":{"type":"createGate","shape":"polygon","name":"CD4_positive","parentId":"@parent.population","x":"X","y":"Y","space":"display","vertices":[[2,0],[6,0],[6,6],[0,6],[0,2]]}}
  ],
  "targets":{"positive":"@child.population"}
}
```

The tab evaluates reducer copies with its native core and exports only selected samples' masks. No dispatch, selection change, autosave or SCE write occurs. Nested membership includes every ancestor. Cluster feedback contains training precision, recall, F1, sample results and target losses at each ancestor. Revise complete candidates from these errors: relax an ancestor that loses targets, refine an impure terminal, or use a local exit when a shared parent is incompatible. Polygons may have at most 128 vertices. A candidate may have at most 128 steps; a host may set a lower limit, and the refusal names the limit in force. A clipped-corner rectangle removes a double-low wedge; clipping fixed bounds can only remove events, so adjust bounds and the diagonal together when recovery needs to increase. Accepted and native-refused candidates consume the budget and are retained. Malformed tool arguments are refused before preview.

The agent proposes and optimizes; the server supplies feedback and enforces the declared protocol. It does not guarantee a global optimum. The loop is **propose → native preview → training feedback → revise → freeze → human review**. A change to the live tree, the data, the assay or the samples' metadata ends the session; selecting a population or gate, panning, or viewing another file with the same geometry owner and pending target does not. Viewing a file with a different edit owner or target advances the revision and requires a new search. While a cluster search runs, `gatelab_evaluate` scores only its training samples; validation is read once, by `gatelab_fit_finish`.

`gatelab_fit_finish` closes cluster search before reading validation, scores valid retained candidates once, and selects the highest declared objective subject to constraints. Ties prefer fewer gates, then earlier candidates. No further candidate is accepted, including after validation failure. Population mode instead requires `candidateId` and a selection rationale. The frozen proposal retains original commands and aliases. Hypothetical IDs must never be applied as live IDs: replay original commands through the reviewed workflow, rebinding aliases to IDs returned by each actual apply. Saving remains the user's action.

The mandatory append-only JSONL history contains the baseline, manifest, declared references and hashes, rationales, geometry, training feedback and final validation selection. Keep this private local artifact in the experiment record. Existing history files are never overwritten. `gatelab_fit_cancel` or **End search** stops a search without applying or undoing gates. A server restart loses its active in-memory search; the history remains. Restarting after seeing validation is a new experiment and cannot be described as an untouched holdout. This protocol cannot stop other tools or the user inspecting test labels; blinding remains an experimental responsibility.

## 16. Strategy proposals

A whole strategy proposed at once (keyed steps, the `@key.population`, `@key.gate` and `@root` aliases, and the target populations) is a strategy proposal, whatever proposes it. An agent is one source of them; a host is another (GateLabR sends one from R), and a file can be a third. Every source gets the same checks: at most 128 steps (or the lower limit the host sets), keys that are unique identifiers, no undo or redo, each command checked as `gatelab_apply` checks it, and 1 to 128 targets that resolve to populations.

- **From an agent**, the relay's `proposal` method (used by `gatelab_fit_candidate`) replays the steps on a copy of the gating and returns the populations, gates and memberships. Nothing changes; the method name and the tools are as they were, so a tab with an older core still answers them. A frozen proposal is applied command by command with `gatelab_apply`, as section 15 says.
- **From any other source**, the tab replays the proposal the same way and opens a Strategy proposal dialog: the source, the writer, the rationale, the steps, the gates and populations it makes, any existing gate or population it would change or remove, and the pooled counts of its new and target populations. Nothing changes until the user chooses Apply proposal; the proposal is then applied exactly as previewed, as one step that Undo removes. Reject drops it. If the gating changed while the dialog was open, the tab previews the proposal again on the gating as it is and the user decides again.
- Every gate an applied proposal makes records its source in `provenance.source`: `agent` for the relay, otherwise the source the proposal named (`host` or `file`). The agent sees these gates in `gatelab_describe` like any other, and a `changed` event when one is applied.

