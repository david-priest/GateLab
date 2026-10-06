// tools.mjs — the tools an agent sees, each a thin wrapper over one request to the GateLab tab.
// The descriptions are the agent's manual: what the numbers mean, which space a gate is in, and
// what it may not do (save). Keep them in step with src/agent/commands.ts and protocol.ts.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { json } from "./mcp.mjs";
import { RelayError } from "./relay.mjs";

/** The specification an agent reads once, next to this file; gatelab_guide returns it. */
export const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), "AGENT_SPEC.md");

export const INSTRUCTIONS = `GateLab is a gating tool for flow and mass cytometry. These tools read and change the gating in a GateLab tab that the user connected to this relay; every change appears in the user's tab at once, as an ordinary gate with a badge saying it was yours, and the user can move, rename or undo it like any other.

How to work:
0. gatelab_guide once, before the first gate: the whole contract — the data model, the coordinate spaces, every command with its fields and refusals (the quadrant order Q1 = x− y+, Q2 = x+ y+, Q3 = x+ y−, Q4 = x− y−), what the user sees, and the GateLabR host.
1. gatelab_status, then gatelab_describe: the files with their metadata, the channels as drawn (each with its transform), the population tree with counts per sample and pooled, the gates with their coordinates, and the view.
2. Look before you gate: gatelab_distribution gives a histogram (with quantiles and its valleys — the antimodes where a threshold goes) or a 2-D binned density, in display units (the axes as drawn), per sample or pooled; gatelab_stats gives marker medians and, with thresholds, the fraction positive; gatelab_render gives a PNG of the plot after gatelab_view (with fit: true) puts the population and axes on screen.
3. gatelab_preview a command to see the counts it would give; then gatelab_apply it with a rationale the user will read on the gate.
4. Check the result per sample, not only pooled: a threshold that fits the pool can miss a file whose staining sits elsewhere; gatelab_distribution with sampleIds shows each file's own valleys, and the metadata tells which files belong together.
5. Keep the tree tidy: deleting a gate leaves its population ungated (100%), so use deletePopulation for a population you no longer want; edit a gate in place rather than delete and redraw.
6. Look at what you drew: gatelab_render after gatelab_view. If the data is cut off at an edge, gatelab_view with fit: "data" shows every event (the Fit button's frame drops the pile at zero of an arcsinh axis), or set xRange/yRange yourself.
7. A shape traced from density: a convex hull bulges, so on a cloud with a tail toward an axis (PD-1-negative cells along PD-1 = 0) cut the tail at its valley before taking the hull, or the "high" gate holds the low cells too.

Rules: coordinates in commands are in the space you say — "display" is the axes as drawn, the same units gatelab_distribution reports; "raw" is raw channel values. A gate is drawn only on plots with its own x and y, so put x and y the way the user's gates on the same channels have them. A null range bound is the edge of the data (not an infinite edge), so a range is always drawn within the chart. Name parents and gates by the ids gatelab_describe gives. You cannot save the workspace or write to the SCE: saving is the user's, in the tab. gatelab_export writes a file of the current gating and memberships for another process to read.`;

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
  return [
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
      description: "Whether a GateLab tab is connected to this relay, which app and workspace it is, and the address the user pastes into GateLab's Agent menu (Agent ▸ Connect to an agent…) to connect one.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => json({ connected: relay.connected, tab: relay.info, revision: relay.revision, address: relay.url, howToConnect: "In GateLab, open the Agent menu in the header, choose Connect to an agent…, and paste the address." }),
    },
    {
      name: "gatelab_describe",
      description: "The loaded data and gating: channels as drawn (key, label, kind, transform), samples (id, name, events, viewed, checked), the population tree in order with each population's gates and counts per sample and pooled, every gate's geometry in its own space, and the view (active population, viewed sample, axes). Call it first and after the user changes something.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => call("describe", {}),
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
      description: "Put a population, a sample and two channels on the user's Gating plot, so they see what you are looking at, and set the axes: fit: true fits them as the Fit button does (the viewed file's 0.1st to 99.9th percentiles, widened to the gates); fit: \"data\" fits them to every event of every sample, 2% past the last, widened to the gates, so nothing is cut off; xRange/yRange hold an axis at a range in display units. The reply reports the ranges shown. gatelab_render then draws that plot.",
      inputSchema: {
        type: "object",
        properties: {
          populationId: { type: "string" }, sampleId: { type: "string" }, x: { type: "string" }, y: { type: "string" },
          fit: { anyOf: [{ type: "boolean" }, { type: "string", enum: ["data"] }] },
          xRange: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          yRange: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
        },
        additionalProperties: false,
      },
      run: (args) => call("view", args),
    },
    {
      name: "gatelab_render",
      description: "A PNG of the Gating plot as the user sees it: the events of the active population on the current axes with the gates drawn. Set the view first with gatelab_view.",
      inputSchema: { type: "object", properties: { width: { type: "integer", minimum: 100, maximum: 4000, description: "Pixels wide; the plot's own size when absent." } }, additionalProperties: false },
      run: async (args) => {
        try {
          const result = await relay.call("render", args);
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
          const [workspace, memberships] = await Promise.all([relay.call("workspace", {}), relay.call("memberships", { populationIds: args.populationIds })]);
          const payload = {
            format: "gatelab-agent-export", version: 1, exportedAt: new Date().toISOString(),
            tab: relay.info, revision: memberships.revision,
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
