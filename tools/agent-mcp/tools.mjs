// tools.mjs — the tools an agent sees, each a thin wrapper over one request to the GateLab tab.
// The descriptions are the agent's manual: what the numbers mean, which space a gate is in, and
// what it may do only with the user's yes (save a copy). Keep them in step with src/agent/commands.ts
// and protocol.ts.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { json } from "./mcp.mjs";
import { RelayError } from "./relay.mjs";
import { createGatingFit } from "./gating-fit.mjs";
import { contextOf, evaluateMemberships, populationChain, sha256, snapshotKey } from "./feedback.mjs";

/** The specification an agent reads once, next to this file; gatelab_guide returns it. */
export const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), "AGENT_SPEC.md");

export const INSTRUCTIONS = `GateLab is a gating tool for flow and mass cytometry. These tools read and change the gating in a GateLab tab that the user connected to this relay; every change appears in the user's tab at once, as an ordinary gate with a badge saying it was yours, and the user can move, rename or undo it like any other.

How to work:
0. gatelab_guide once, before the first gate: the whole contract — the data model, the coordinate spaces, every command with its fields and refusals (the quadrant order Q1 = x− y+, Q2 = x+ y+, Q3 = x+ y−, Q4 = x− y−), what the user sees, and the GateLabR host.
1. gatelab_status, then gatelab_describe: the files with their metadata, the channels as drawn (each with its transform), the population tree with counts per sample and pooled, the gates with their coordinates, and the view.
2. Look before you gate: gatelab_distribution gives a histogram (with quantiles and its valleys — the antimodes where a threshold goes) or a 2-D binned density, in display units (the axes as drawn), per sample or pooled; gatelab_stats gives marker medians and, with thresholds, the fraction positive; gatelab_render gives a PNG of the plot after gatelab_view (with fit: true) puts the population and axes on screen.
3. gatelab_context makes the actual plot selection, assay and population chain explicit. gatelab_preview a command to see the counts it would give; then gatelab_apply it with a rationale the user will read on the gate. When aligned reference masks are supplied locally, gatelab_evaluate reports exact agreement and losses at ancestors on explicitly named samples. Preserve natural prevalence, name the split used for feedback, and keep final-test references out of discovery.
For iterative work use gatelab_fit_start, gatelab_fit_candidate and gatelab_fit_finish. Population mode fits a described phenotype and reports no reference concordance. Cluster mode fixes aligned references, disjoint training/validation samples, objective and candidate budget; feedback during search is training-only. Propose complete shared or semi-shared strategies with step aliases; revise gates from counts and ancestor losses, retaining the reasons. Rectangles and simple polygons (including clipped corners, up to 128 vertices) use the same native-core preview. Finish closes the search before reading validation, selects once and freezes commands for human review. No fit tool applies gates or saves an SCE. Do not inspect final test labels or restart after seeing validation to improve a claimed held-out result.
4. Check the result per sample, not only pooled: a threshold that fits the pool can miss a file whose staining sits elsewhere; gatelab_distribution with sampleIds shows each file's own valleys, and the metadata tells which files belong together.
5. Keep the tree tidy: deleting a gate leaves its population ungated (100%), so use deletePopulation for a population you no longer want; edit a gate in place rather than delete and redraw.
6. Look at what you drew: gatelab_render after gatelab_view. If the data is cut off at an edge, gatelab_view with fit: "data" shows every event (the Fit button's frame drops the pile at zero of an arcsinh axis), or set xRange/yRange yourself.
7. A shape traced from density: a convex hull bulges, so on a cloud with a tail toward an axis (PD-1-negative cells along PD-1 = 0) cut the tail at its valley before taking the hull, or the "high" gate holds the low cells too.
8. To start from files on this computer: gatelab_open_files with absolute paths opens FCS files in the tab as its Add files button does, and gatelab_import_gating imports a Gating-ML file, a FlowJo workspace or a FACSChorus experiment onto them as its Import gating does. The import asks the user in its dialog whenever the app would (an existing strategy to merge or replace, a compensation choice, FlowJo's grid); the call waits for their answer and says whether they applied or cancelled it.
9. To save the work: gatelab_save asks the user, in the tab, to confirm saving a copy of the workspace to an absolute path on this computer ("linked": the workspace file alone, which finds its FCS files by name; "portable": one file holding the workspace and every FCS file, to send to someone). Nothing is written unless they press Save; the call waits for their answer. It never writes the user's own workspace file and never presses Save to SCE.
10. To show the user a gating strategy to inspect or print: gatelab_view with strategy {populationIds} opens the Strategy tab on those populations (one: its path; several: one grid from the root), and strategy's layout, columns, showArrows, arrowWidth and arrowAnchor set the tab's own layout controls (layout "flow" is the tab's Wrapped); gatelab_render then returns that grid, as a PNG to look at or, with format "svg" and a path, as the SVG file the tab's own export writes. It changes no gate and selects nothing in the tree.

Rules: coordinates in commands are in the space you say — "display" is the axes as drawn, the same units gatelab_distribution reports; "raw" is raw channel values. A gate is drawn only on plots with its own x and y, so put x and y the way the user's gates on the same channels have them. A null range bound is the edge of the data (not an infinite edge), so a range is always drawn within the chart. Name parents and gates by the ids gatelab_describe gives. You save only through gatelab_save, a copy the user confirms in the tab; you cannot write their own workspace file or the SCE. gatelab_export writes a file of the current gating and memberships for another process to read.`;

const COMMAND_SCHEMA = {
  type: "object",
  description: "One command. Types: createGate {shape: \"rectangle\"|\"polygon\", name, parentId, x, y, space, vertices: [[x,y],…]} (a rectangle is two opposite corners); createRange {name, parentId, x, y, space, xBounds: [low|null, high|null], yBounds: [low|null, high|null]} (null = the edge of the data on that side; a marker-positive threshold is xBounds [t, null], yBounds [null, null]); createEllipse {name, parentId, x, y, space, center: [x,y], radii: [rx, ry]}; createQuadrant {name, parentId, x, y, space, center: [x,y], names?: [Q1,Q2,Q3,Q4]} (Q1 = x− y+ upper left, Q2 = x+ y+ upper right, Q3 = x+ y− lower right, Q4 = x− y− lower left); definePopulation {name, parentId, gates: [{gateId, include}]} (the AND of gates already drawn, NOT for include: false); editGate {gateId, vertices}; moveQuadrantCenter {gateId, center}; renameGate {gateId, name}; renamePopulation {populationId, name}; movePopulation {populationId, targetId, placement: \"inside\"|\"before\"|\"after\"}; deleteGate {gateId} (its population stays, ungated); deletePopulation {populationId} (its gates stay); undo; redo. space is \"display\" (axes as drawn) or \"raw\".",
  properties: {
    type: { type: "string", enum: ["createGate", "createRange", "createEllipse", "createQuadrant", "definePopulation", "editGate", "moveQuadrantCenter", "renameGate", "renamePopulation", "movePopulation", "deleteGate", "deletePopulation", "undo", "redo"] },
  },
  required: ["type"],
  additionalProperties: true,
};

const SERIES_PROPERTIES = {
  populationId: { type: "string", description: "The population whose events are read; the root when absent." },
  sampleIds: { type: "array", items: { type: "string" }, description: "The samples read; the viewed one when absent (the checked ones when pooled)." },
  pooled: { type: "boolean", description: "One series over the chosen samples together instead of one per sample." },
};

/** How long a call may wait on the tab when it waits on the user or moves large files. */
const LONG_CALL_MS = 10 * 60_000;

const refused = (error) => ({ content: [{ type: "text", text: error instanceof RelayError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error) }], isError: true });

/**
 * @param {Awaited<ReturnType<typeof import("./relay.mjs").startRelay>>} relay
 */
export function gatelabTools(relay) {
  const call = async (method, params) => {
    try {
      return json(await relay.call(method, params));
    } catch (error) {
      return refused(error);
    }
  };
  // One fit session per server, shared with gatelab_evaluate so a search's held-out samples stay unscored.
  const fit = createGatingFit(relay);
  // The Strategy grid as the tab's SVG export writes it, through an upload slot like a save's: the
  // file holds each panel's events as an image at the export's dpi, too large for a reply.
  const renderSvg = async (args) => {
    let slot;
    try {
      if (args.width !== undefined) throw new Error("width sizes the PNG; the SVG is the grid at its own size, its events drawn at dpi.");
      if (typeof args.path !== "string" || !isAbsolute(args.path) || !/\.svg$/i.test(args.path)) throw new Error("path must be an absolute path ending in .svg.");
      slot = await relay.receiveFile(args.path, { overwrite: args.overwrite === true });
      const result = await relay.call("render", { format: "svg", upload: slot.path, ...(args.dpi === undefined ? {} : { dpi: args.dpi }) }, { timeoutMs: LONG_CALL_MS });
      // A core from before the SVG ignores the format and answers with a PNG, posting nothing.
      if (result?.format !== "svg") throw new Error("unknown-method: the tab's core predates writing the Strategy grid as SVG (it answered with a PNG); update the core, then gatelab_reload.");
      const written = await slot.written;
      return json({ format: "svg", ...written, width: result.width, height: result.height, dpi: result.dpi, view: result.view, revision: result.revision });
    } catch (error) {
      return refused(error);
    } finally {
      slot?.cancel();
    }
  };
  return [
    ...fit.tools.map((tool) => ({ ...tool, run: async (args) => { try { return json(await tool.run(args)); } catch (error) { return refused(error); } } })),
    {
      name: "gatelab_guide",
      description: "The specification of this interface, to read once before the first gate: what the tab is, how to connect, the data model gatelab_describe returns, the coordinate spaces, every command with its fields, conventions and refusals, what the user sees, the rules of good gating, and what differs under GateLabR.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        try {
          return { content: [{ type: "text", text: await readFile(SPEC_PATH, "utf8") }] };
        } catch (error) {
          return refused(error);
        }
      },
    },
    {
      name: "gatelab_status",
      description: "Whether a GateLab tab is connected to this relay, which app and workspace it is, and the address the user pastes into GateLab's Agent menu (Agent ▸ Connect to an agent…) to connect one. With appUrl (where GateLab is served, such as http://localhost:5173/), also the link that opens GateLab already connected, for a browser the agent drives or to give the user.",
      inputSchema: { type: "object", properties: { appUrl: { type: "string", description: "The http(s) address GateLab is served from." } }, additionalProperties: false },
      run: async (args = {}) => {
        let launchUrl;
        if (args.appUrl !== undefined) {
          try {
            const app = new URL(args.appUrl);
            if (app.protocol !== "http:" && app.protocol !== "https:") throw new Error("not http(s)");
            app.searchParams.set("agent", relay.url);
            launchUrl = app.toString();
          } catch {
            return refused(new Error(`appUrl is not an http(s) address: ${String(args.appUrl)}`));
          }
        }
        return json({
          connected: relay.connected, tab: relay.info, revision: relay.revision, address: relay.url,
          howToConnect: "In GateLab, open the Agent menu in the header, choose Connect to an agent…, and paste the address.",
          ...(launchUrl ? { launchUrl } : {}),
        });
      },
    },
    {
      name: "gatelab_open_files",
      description: "Open FCS files on this computer in the user's tab, as its Add files button does: each is added to the workspace as a sample, and a .cvw of the same name given with it is attached as its cell images. The files go from this relay to the tab and nowhere else. Returns the samples added, the files that failed with the app's reason, and every sample now loaded. Refused under GateLabR, which serves its own data.",
      inputSchema: {
        type: "object",
        properties: { paths: { type: "array", items: { type: "string" }, minItems: 1, description: "Absolute paths of .fcs files (and any .cvw beside them)." } },
        required: ["paths"],
        additionalProperties: false,
      },
      run: async (args) => {
        try {
          if (!Array.isArray(args.paths) || args.paths.length === 0) throw new Error("paths must be a nonempty list.");
          const files = [];
          for (const path of args.paths) files.push(await relay.offerFile(path));
          return json(await relay.call("openFiles", { files }, { timeoutMs: LONG_CALL_MS }));
        } catch (error) {
          return refused(error);
        }
      },
    },
    {
      name: "gatelab_import_gating",
      description: "Import a gating file on this computer into the user's tab, as its Import gating menu does: Gating-ML 2.0 (.xml), a FlowJo workspace (.wsp, .flowjo) or a FACSChorus experiment (.cef), onto the FCS files already open (gatelab_open_files first). A FlowJo workspace pairs each open file with its own sample, so files gated differently become one tree tailored per file. When the app has a question (an existing strategy to merge or replace, a compensation matrix, FlowJo's grid) the user answers it in the import dialog; the call waits for them, up to 10 minutes. Returns outcome \"applied\", \"cancelled\" (the user closed the dialog) or \"failed\", with the app's own report, which for a FlowJo workspace says whether every population counted as the workspace recorded.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path of the gating file." } },
        required: ["path"],
        additionalProperties: false,
      },
      run: async (args) => {
        try {
          const file = await relay.offerFile(args.path);
          return json(await relay.call("importGating", { file }, { timeoutMs: LONG_CALL_MS }));
        } catch (error) {
          return refused(error);
        }
      },
    },
    {
      name: "gatelab_save",
      description: "Save a copy of the user's workspace to an absolute path on this computer, once the user confirms it in the tab: a dialog names the copy, the path and you, and nothing is written unless they press Save. kind \"linked\" (default) writes the workspace file alone, which finds its FCS files by name and recorded acquisition; \"portable\" writes one archive holding the workspace and every FCS file, for sending to someone (refused under GateLabR, which holds no FCS files). The folder must exist; a file already at the path is refused unless overwrite is true, and the dialog then says it will be replaced. The call waits for the user, up to 10 minutes. Returns outcome \"saved\" with the path, the bytes written and their SHA-256, or \"cancelled\". The user's own workspace file, its unsaved changes and any SCE are untouched.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path of the copy, ending in .gatelab." },
          kind: { type: "string", enum: ["linked", "portable"] },
          overwrite: { type: "boolean", description: "Replace a file already at the path." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      run: async (args) => {
        let slot;
        try {
          const kind = args.kind ?? "linked";
          if (kind !== "linked" && kind !== "portable") throw new Error("kind must be \"linked\" or \"portable\".");
          slot = await relay.receiveFile(args.path, { overwrite: args.overwrite === true });
          const result = await relay.call("save", { kind, target: args.path, overwrite: args.overwrite === true, upload: slot.path }, { timeoutMs: LONG_CALL_MS });
          if (result.outcome !== "saved") return json({ outcome: result.outcome, path: args.path, revision: result.revision });
          return json({ outcome: "saved", ...(await slot.written), kind, revision: result.revision });
        } catch (error) {
          return refused(error);
        } finally {
          slot?.cancel();
        }
      },
    },
    {
      name: "gatelab_describe",
      description: "The loaded data and gating: channels as drawn (key, label, kind, transform), samples (id, name, events, viewed, checked), the population tree in order with each population's gates and counts per sample and pooled, every gate's geometry in its own space, and the view (active population, viewed sample, axes). Call it first and after the user changes something.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => call("describe", {}),
    },
    {
      name: "gatelab_context",
      description: "Read the active population chain, actual plot pooling and assay binding, checked samples, channel transforms and sample-manifest hash. Population totals pool all loaded samples; gate-card counts test geometry inside the active displayed population. Older cores explicitly report unknown plot pooling and assay rather than guessing.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        try { return json(contextOf(await relay.call("describe", {}))); }
        catch (error) { return refused(error); }
      },
    },
    {
      name: "gatelab_evaluate",
      description: "Read-only exact agreement of cumulative populations with locally supplied aligned reference masks: precision, recall, F1, false-positive rate, prevalence, abundance bias, per-sample and optional metadata-group results, and target losses at each ancestor. Explicit sample selection prevents silent balancing or test-set inclusion. The local reference file uses gatelab-reference-masks version 1 (see guide); it never changes the SCE or gates.",
      inputSchema: {
        type: "object", properties: {
          referencePath: { type: "string", description: "Absolute path to a local gatelab-reference-masks JSON file; event order must match the loaded samples." },
          populationIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 128, uniqueItems: true },
          sampleIds: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true, description: "Explicit evaluation samples; never inferred from the current plot or all loaded files." },
          groupBy: { type: "string", description: "Sample metadata column, such as donor, for grouped metrics. Missing values are refused." },
          projectedPrevalence: { type: "number", minimum: 0, maximum: 1, description: "Optional precision projection assuming unchanged sensitivity and false-positive rate." },
        }, required: ["referencePath", "populationIds", "sampleIds"], additionalProperties: false,
      },
      run: async (args) => {
        try {
          if (typeof args.referencePath !== "string" || !isAbsolute(args.referencePath)) throw new Error("referencePath must be absolute.");
          const referenceText = await readFile(args.referencePath, "utf8");
          const reference = JSON.parse(referenceText);
          const before = await relay.call("describe", {});
          const heldOut = fit.evaluationRefusal(args.sampleIds, before);
          if (heldOut) throw new Error(heldOut);
          if (!Array.isArray(args.populationIds) || !args.populationIds.length) throw new Error("populationIds must be nonempty.");
          const wanted = [...new Set(args.populationIds.flatMap((id) => populationChain(before, id).map((p) => p.id)))];
          const memberships = await relay.call("memberships", { populationIds: wanted });
          const after = await relay.call("describe", {});
          if (snapshotKey(before) !== snapshotKey(after)) throw new Error("The data, selection or gating changed while reading feedback; retry.");
          return json({ ...evaluateMemberships(before, memberships, reference, args), referenceSha256: sha256(referenceText) });
        } catch (error) { return refused(error); }
      },
    },
    {
      name: "gatelab_distribution",
      description: "Where the events of a population lie on one channel (a histogram with quantiles, mean and valleys — the antimodes where a threshold between two populations goes, deepest first) or two (also a bins×bins grid, row-major by y bin then x bin), in display units, per sample or pooled. The edges come back with the counts; `range` fixes the axes so series compare.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "string", description: "A channel key from gatelab_describe." },
          y: { type: "string", description: "A second channel for a 2-D grid." },
          bins: { type: "integer", minimum: 2, maximum: 256, description: "Bins per axis; 64 when absent." },
          range: { type: "object", properties: { x: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }, y: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 } }, additionalProperties: false },
          ...SERIES_PROPERTIES,
        },
        required: ["x"],
        additionalProperties: false,
      },
      run: (args) => call("distribution", args),
    },
    {
      name: "gatelab_stats",
      description: "Marker medians (display units) and event counts per population, per sample or pooled, and with `thresholds` the fraction of each population at or above a display-space value per channel; medians of populations over 200,000 events are read on every k-th event and say so.",
      inputSchema: {
        type: "object",
        properties: {
          populationIds: { type: "array", items: { type: "string" }, description: "Every population when absent." },
          channels: { type: "array", items: { type: "string" }, description: "Every channel when absent." },
          thresholds: { type: "object", additionalProperties: { type: "number" }, description: "Per channel key, a display-space threshold; the fraction at or above it comes back as `positive`." },
          ...SERIES_PROPERTIES,
        },
        additionalProperties: false,
      },
      run: (args) => call("stats", args),
    },
    {
      name: "gatelab_preview",
      description: "What a command would do, without doing it: every population's counts afterwards (the new ones marked) and the gates. Use it to tune a boundary before gatelab_apply.",
      inputSchema: { type: "object", properties: { command: COMMAND_SCHEMA }, required: ["command"], additionalProperties: false },
      run: (args) => call("preview", { command: args.command }),
    },
    {
      name: "gatelab_apply",
      description: "Do a command in the user's tab. The rationale is required and is shown on every gate the command creates. Pass expectedRevision (from the last describe or apply) to be refused with \"conflict\" if the user changed the gating meanwhile. Returns the populations and gates afterwards and the ids created.",
      inputSchema: {
        type: "object",
        properties: {
          command: COMMAND_SCHEMA,
          rationale: { type: "string", description: "Why, in one or two sentences the user will read." },
          expectedRevision: { type: "integer" },
        },
        required: ["command", "rationale"],
        additionalProperties: false,
      },
      run: (args) => call("apply", args),
    },
    {
      name: "gatelab_view",
      description: "Put a population, a sample and two channels on the user's Gating plot, so they see what you are looking at, and set the axes: fit: true fits them as the Fit button does (the viewed file's 0.1st to 99.9th percentiles, widened to the gates); fit: \"data\" fits them to every event of every sample, 2% past the last, widened to the gates, so nothing is cut off; xRange/yRange hold an axis at a range in display units. The reply reports the ranges shown. gatelab_render then draws that plot. With strategy (or tab: \"strategy\") it opens the Strategy tab instead, drawing the gating strategy of the populations named, for the user to inspect, export or print: one population is its path (fullPath: true from the root); several, or mode \"multi\", are one grid from the root, laid out as a tree (a column per depth) or, with layout \"flow\" (the tab's Wrapped), walked depth first and wrapped into rows of `columns` panels, with arrows from each gate to the panel it makes (showArrows, arrowWidth, arrowAnchor). The ids must be populations of the active tree, not the root, each once. strategy changes only the tab's controls, as the user sets them, and they stay set: no gate, no selection in the tree, and the revision does not move. x, y, fit and the ranges are for the Gating plot and are refused with the Strategy tab. The reply's strategy is what the tab now holds, every layout control included.",
      inputSchema: {
        type: "object",
        properties: {
          populationId: { type: "string" }, sampleId: { type: "string" }, x: { type: "string" }, y: { type: "string" },
          fit: { anyOf: [{ type: "boolean" }, { type: "string", enum: ["data"] }] },
          xRange: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          yRange: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          tab: { type: "string", enum: ["gating", "strategy"], description: "The tab shown: \"gating\" by default, \"strategy\" when strategy is given." },
          strategy: {
            type: "object",
            description: "What the Strategy tab draws.",
            properties: {
              populationIds: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true, description: "Population ids from gatelab_describe, in the active tree; not the root." },
              mode: { type: "string", enum: ["single", "multi"], description: "\"single\": one population's path (exactly one id). \"multi\": the populations together in one grid. Default: single for one id, multi for more." },
              fullPath: { type: "boolean", description: "Single mode only: draw every gate from the root, not only the population's own. Left as the tab has it when absent." },
              layout: { type: "string", enum: ["tree", "flow"], description: "Multi mode only, the tab's Layout: \"tree\", a column per depth and a row per traced population; \"flow\" (shown as Wrapped), the tree walked depth first and wrapped into rows of `columns` panels. Left as the tab has it when absent." },
              columns: { type: "integer", minimum: 1, maximum: 12, description: "The tab's Columns: panels per row of a single strip and of the Wrapped layout (a tree has a column per depth). Left as the tab has it when absent." },
              showArrows: { type: "boolean", description: "Multi mode only: an arrow from each gate to the panel of the population it makes, routed between the panels and kept in the exports. Left as the tab has it when absent." },
              arrowWidth: { type: "number", minimum: 0.5, maximum: 6, description: "Multi mode, arrows on: their line width in px; the heads grow with it. Left as the tab has it when absent." },
              arrowAnchor: { type: "string", enum: ["label", "gate"], description: "Multi mode, arrows on: where an arrow leaves its panel, level with the gate's label or with the gate's centre. Left as the tab has it when absent." },
            },
            required: ["populationIds"],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      run: async (args) => {
        try {
          const result = await relay.call("view", args);
          // A core from before the Strategy selection ignores it and answers on the Gating tab.
          if ((args.strategy !== undefined || args.tab === "strategy") && result?.tab !== "strategy") {
            return refused(new Error("unknown-method: the tab's core predates opening the Strategy tab from an agent (it answered on the Gating tab); update the core, then gatelab_reload."));
          }
          return json(result);
        } catch (error) {
          return refused(error);
        }
      },
    },
    {
      name: "gatelab_render",
      description: "A PNG of the plot the user sees: on the Gating tab, the events of the active population on the current axes with the gates drawn; on the Strategy tab, the strategy grid as its exports compose it (every panel, the arrows, the title), once the tab has finished drawing. Set the view first with gatelab_view. The reply's view.tab says which. With format \"svg\" and an absolute path ending in .svg, on the Strategy tab only, it writes instead the file the tab's own SVG export writes: axes, gates, labels, arrows and title as vector, each panel's events an image at dpi (the tab's Export DPI when absent). The folder must exist; a file already there is refused unless overwrite is true. Returns the path, bytes, SHA-256, the grid's size in px and the dpi. The gating tree the export can add as a second file is not written.",
      inputSchema: {
        type: "object",
        properties: {
          width: { type: "integer", minimum: 100, maximum: 4000, description: "PNG only: pixels wide; the plot's (or the grid's) own size when absent." },
          format: { type: "string", enum: ["png", "svg"], description: "\"png\" (default): an image in the reply. \"svg\": the Strategy grid written to path." },
          path: { type: "string", description: "SVG only: absolute path of the file, ending in .svg." },
          dpi: { type: "integer", minimum: 72, maximum: 1200, description: "SVG only: the resolution each panel's events are drawn at; the Strategy tab's Export DPI when absent." },
          overwrite: { type: "boolean", description: "SVG only: replace a file already at path." },
        },
        additionalProperties: false,
      },
      run: async (args = {}) => {
        if ((args.format ?? "png") === "svg") return renderSvg(args);
        if (args.format !== undefined && args.format !== "png") return refused(new Error("format must be \"png\" or \"svg\"."));
        if (args.path !== undefined || args.dpi !== undefined || args.overwrite !== undefined) return refused(new Error("path, dpi and overwrite are for format \"svg\"."));
        try {
          const result = await relay.call("render", args.width === undefined ? {} : { width: args.width });
          const data = String(result.png).replace(/^data:image\/png;base64,/, "");
          return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: JSON.stringify({ view: result.view, width: result.width, height: result.height, revision: result.revision }) }] };
        } catch (error) {
          return refused(error);
        }
      },
    },
    {
      name: "gatelab_wait_for_change",
      description: "Wait until the user changes the gating in the tab (or the timeout passes), then return the new revision; null on timeout. Use it when you have asked the user to adjust something.",
      inputSchema: { type: "object", properties: { timeoutSeconds: { type: "integer", minimum: 1, maximum: 600 } }, additionalProperties: false },
      run: async (args) => json({ revision: await relay.waitForChange((args.timeoutSeconds ?? 60) * 1000) }),
    },
    {
      name: "gatelab_reload",
      description: "Reload the user's tab: it comes back with the GateLab core now installed under it and the gating as the host last autosaved it, and reconnects by itself. Use after a new core has been installed (GateLabR reinstalled); wait a few seconds, then gatelab_status.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => call("reload", {}),
    },
    {
      name: "gatelab_export",
      description: "Write the current gating (the workspace JSON as GateLab saves it) and every population's membership per sample (packed bits, LSB first) to a JSON file at an absolute path, for another process to read. Not a save: the user's workspace and SCE are untouched. Keep the path outside synced folders such as Google Drive.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, populationIds: { type: "array", items: { type: "string" } } }, required: ["path"], additionalProperties: false },
      run: async (args) => {
        if (typeof args.path !== "string" || !isAbsolute(args.path)) return refused(new Error("path must be absolute."));
        try {
          const before = await relay.call("describe", {});
          const [workspace, memberships] = await Promise.all([relay.call("workspace", {}), relay.call("memberships", { populationIds: args.populationIds })]);
          const after = await relay.call("describe", {});
          if (snapshotKey(before) !== snapshotKey(after) || workspace.revision !== before.revision || memberships.revision !== before.revision) throw new Error("The data or gating changed during export; no file written. Retry.");
          const payload = {
            format: "gatelab-agent-export", version: 1, exportedAt: new Date().toISOString(),
            tab: relay.info, revision: memberships.revision,
            context: contextOf(before),
            workspace: workspace.json ? JSON.parse(workspace.json) : null,
            samples: memberships.samples, populations: memberships.populations,
          };
          await mkdir(dirname(args.path), { recursive: true });
          await writeFile(args.path, JSON.stringify(payload));
          return json({ path: args.path, revision: memberships.revision, populations: memberships.populations.map((p) => ({ id: p.id, name: p.name })), samples: memberships.samples.length });
        } catch (error) {
          return refused(error);
        }
      },
    },
  ];
}
