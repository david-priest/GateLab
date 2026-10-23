# Headless runner

`npm run headless` gates FCS files with GateLab's engine without the app open. It imports a gating tree the way the app imports it, evaluates every population through the app's own store, and writes the counts, and optionally each event's membership, each population's events as FCS, and a gating-strategy figure. It is meant for analyses that need GateLab's populations in a script: counting barcode populations across runs, checking a tree exported from another program, or recording the counts behind a figure.

```sh
npm run headless -- --gating tree.xml --out counts/ D1.fcs D2.fcs
```

`npm ci` must have been run in the checkout; the runner uses the esbuild and jsdom that GateLab's development install brings. `npm run headless -- --help` lists every option.

## Gating sources

The tree is detected from the file's content, not its extension.

| Source | What happens |
|---|---|
| Gating-ML 2.0 (FlowKit, flowUtils, FlowJo, GateLab, GateLabR) | Imported onto each FCS file given, as the app's import onto that file opened alone. |
| Cytobank's Gating-ML export (with Cytobank's `custom_info`) | As above, read by Cytobank's model: each population's parent from its `booleanExpression`, Time coordinates in stored ticks. Gates Cytobank tailored for a file (`fcs_file_filename`) go onto the FCS file of that name, with that file's coordinates, and onto no other. |
| FlowJo workspace (`.wsp`) | Each FCS file is paired with its workspace sample by name and recorded acquisition ($TOT, $DATE, $BTIM, $ETIM, GUID), as the app pairs them, and that sample's tree is converted and imported with FlowJo's gate grid. `--wsp-sample` names the sample instead; `--wsp-tree` chooses one of several independent trees. FlowJo's own count for each population is written beside GateLab's. |
| GateLab workspace (`.gatelab`) | Reopened as the app reopens it. A portable workspace carries its FCS files and takes none on the command line. A linked workspace takes the FCS files it declares, which are matched by name and recorded acquisition. Each file is gated under the hierarchy the workspace assigns it, as the Statistics tab tabulates it. |

For a Gating-ML file or a FlowJo workspace, the FCS files are gated one at a time, so only one file's events are held in memory. Each is opened as the app opens it (instrument detected unless `--instrument` says otherwise), the compensation the tree asks for is resolved and installed as the import dialog resolves it, the channel scales the file records are restored, and the tree is loaded with the store's `importGating` action. Where a FlowJo workspace or a Gating-ML file brings a spillover matrix that differs from the FCS file's own, the app asks which to use and defaults to the workspace's; `--matrix file` keeps the FCS file's.

## What stops a run

The runner never drops part of a tree without saying so.

- A gate on a channel the FCS file lacks stops the import, naming the gates and channels, as in the app. Exit status 1.
- A population the import leaves out (an OR population, a gate with a ratio dimension, a gate whose compensation cannot be held, a Boolean gate GateLab cannot place), a gate whose $PnG could not be restated, a Cytobank compensation the file does not carry, and anything a FlowJo workspace's conversion skipped or altered is a refusal. Each is printed to stderr and recorded in `report.json`, and nothing is counted. Exit status 2. `--allow-partial` counts what was imported; each refusal is still printed and recorded, and the report's status is `partial`.
- A population selector (`--export-fcs`, `--strategy`) that names no population, or a name several populations carry, stops the run before any output is written. Exit status 1.
- An output directory that already holds files is refused, so that no output of an earlier run is mistaken for this one's.
- A linked workspace whose files are not all given, or a portable workspace given FCS files, is refused.

A `.gatelab` version 3 workspace that gates a file on a compensated layer kept by reference to a compensation profile is refused: the app recomputes that layer on a worker, which the runner does not have. A portable workspace carries the compensated values and runs. Cell images linked to a workspace are not opened; they change no count.

## Outputs

| File | Content |
|---|---|
| `counts.csv` | One row per population and file: `file`, `hierarchy` (`.gatelab` only), `population_id` (made when a tree is imported, as in the app, so it differs between runs of a Gating-ML or FlowJo tree; join runs on `path`), `population`, `path` (names from the top of the tree, joined by ` > `), `depth`, `parent_id`, `events`, `parent_events`, `total_events`, `pct_parent`, `pct_total`, and `flowjo_events` for a FlowJo workspace. The root is not a row; `total_events` carries it. Populations are in the app's tree order. |
| `counts.json` | The same rows, with `path` as a list of names. |
| `report.json` | The GateLab version and commit (`+modified` when the checkout has uncommitted changes), the arguments, the SHA-256 of every input, and for each file its event count, instrument, compensation, recorded acquisition, notes and refusals. Written whatever the outcome. |
| `membership/<file>.csv` | With `--membership csv`: one row per event in stored order, an `event` number from 1 and a 0/1 column per population, headed by its path. Large: 1 million events by 20 populations is about 50 MB. |
| `membership.json` | With `--membership bits`: each population's membership packed least significant bit first and base64-encoded, the packing of the agent relay's reference masks. |
| `fcs/<file>/<path>.fcs` | With `--export-fcs`: the population's events through the app's FCS export, with `--fcs-assay` original (default), compensated or display values. `--export-fcs all` writes every population. |
| `strategy/<file>/<path>.svg`, `.pdf` | With `--strategy`: the gates from the root to the population, one panel per gate (see below). |

A population selector is its path, such as `Cells > B1`, or a name only one population carries.

## Strategy figures

The panels are the Strategy tab's: `computeGatingStrategy` gives each gate on the path with its parent events in display space, and `buildStrategyPayload` gives the axis ranges and ticks, the gate's vertices or the curved outline its transform makes, a quadrant's centre and arms, and the counts. The tab draws events with the D3 renderer in `vendor/GateLabR`, which paints on a canvas and does not run in Node, so the runner draws the payload itself: every parent event binned on a 100 × 100 grid and coloured by density in the renderer's jet palette, the gate in its colour (dashed for an excluded gate), the axes, and each step's count of its parent. The SVG and PDF are vector. They are a record of the strategy, not a replacement for the tab's export.

## Large files

The runner holds a file's events in memory as the app does: one file at a time for a Gating-ML or FlowJo tree, every file of a `.gatelab` workspace at once. A CyTOF file of 1.34 million events peaked at 1.8 GB. Node's default heap may be too small for larger runs:

```sh
NODE_OPTIONS=--max-old-space-size=8192 npm run headless -- --gating tree.xml --out counts/ big.fcs
```

## How it runs

`tools/headless/gatelab-headless.mjs` gives Node the DOM parser the Gating-ML and FlowJo readers use (jsdom, as the interoperability tester does), bundles `src/headless/cli.ts` against the checkout's own `src/` with esbuild, and runs it. The bundle is written to the system's temporary directory, named by its content, so nothing is written beside the data. `src/headless/` calls the engine and the store; it changes nothing in them and copies none of their logic, except two short helpers from `App.tsx` (`appliedImportMatrix`, `restoreStoredHierarchy`), which are not exported from a module the runner can load.

## Tests

`src/headless/*.test.ts` run with `npm test`. They are built on a synthetic CyTOF run and a Cytobank-style Gating-ML tree (`src/headless/__fixtures__/syntheticCytobank.ts`) whose expected counts are computed from the classes the events were generated in. Two cases are pinned there because readers of Cytobank's export get them wrong:

- Time bounds in stored ticks. The Time gate starts at 1, the first events are stored at Time 1, and $TIMESTEP is 0.01. A reader that multiplies Time by $TIMESTEP first keeps 24 of the 420 events; GateLab keeps all 420.
- A barcode population's parent in `custom_info` only. Cytobank's BooleanGate for B1 lists B1's own two gates, and its parent appears only in `booleanExpression` (`pop_7 AND gate_10 AND gate_11`). Read without the parent, B1 would also take the DNA-negative events of its pattern (84 events instead of 72).

Each was checked against an engine with the behaviour removed: dropping Cytobank's tick rule failed 4 tests and dropping the `booleanExpression` parent failed 3. The other tests cover per-file tailoring, refusals, the CLI's outputs and exit statuses, a FlowJo workspace written by GateLab's own export, portable and linked `.gatelab` workspaces with a hierarchy per file, and the launcher run in plain Node.
