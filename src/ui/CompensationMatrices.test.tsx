// @vitest-environment jsdom

// A matrix's versions in the Matrices list: shown under the matrix in use, each one used again,
// copied, exported or, when nothing depends on it, deleted.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAndCanonicalizeCompensationMatrix } from "../engine/compensationProfile";
import {
  createCompensationBaselineProfile,
  createCompensationProfileRevision,
  type CompensationProfileRecord,
} from "../engine/compensationProfileRecord";
import { WORKSPACE_COMPENSATION_SCHEMA } from "../engine/workspaceCompensation";
import { CompensationMatrices, type CompensationMatricesProps } from "./CompensationMatrices";
import { buildMatrixLibrary, type MatrixLibraryRow, type MatrixVersionRow } from "./compensationLibrary";

const SETTINGS = { singularTolerance: 1e-12, conditionWarningThreshold: 1e8 };

function scientific(spill: number) {
  const canonical = validateAndCanonicalizeCompensationMatrix({
    sourceChannels: ["FL1-A", "FL2-A"],
    receiverChannels: ["FL1-A", "FL2-A"],
    matrix: [[1, spill], [0.05, 1]],
  }, "flow-spillover");
  if (!canonical.ok) throw new Error("invalid");
  return { kind: "flow-spillover" as const, method: "matrix-inverse" as const, solverVersion: "flow-lu-v1", solverSettings: SETTINGS, matrix: canonical.value };
}

/** One matrix, "beads", made and edited twice: versions 1, 2 (from 1) and 3 (from 2), the third in use. */
async function lineageRows(): Promise<MatrixLibraryRow[]> {
  const base = await createCompensationBaselineProfile(scientific(0.1), {
    profileId: "a",
    name: "beads",
    createdAt: "2026-11-20T00:00:00.000Z",
    origin: { type: "uploaded", fileName: "beads.csv", format: "csv", sourceColumnHeader: "channel" },
  });
  const e1 = await createCompensationProfileRevision(base, scientific(0.2), { profileId: "a-e1", createdAt: "2026-11-20T00:01:00.000Z" });
  const e2 = await createCompensationProfileRevision(e1, scientific(0.3), { profileId: "a-e2", createdAt: "2026-11-20T00:02:00.000Z" });
  const records: CompensationProfileRecord[] = [base, e1, e2];
  return buildMatrixLibrary(
    { schema: WORKSPACE_COMPENSATION_SCHEMA, lineages: [{ baselineProfileId: "a", records }], activeProfileId: "a-e2" },
    [],
    [{ kind: "profile", profileId: "a-e2" }, { kind: "profile", profileId: "a-e2" }],
    "flow-spillover",
    { next: 2, byKey: { "lineage:a": 1 }, primary: null },
  );
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function render(rows: MatrixLibraryRow[], overrides: Partial<CompensationMatricesProps> = {}) {
  const props: CompensationMatricesProps = {
    rows,
    fileCount: 2,
    busy: false,
    planSwitch: () => ({ fileCount: 2, uncovered: [], leavingEmbedded: [], gateCount: 0, populationCount: 0 }),
    onUse: vi.fn(async () => {}),
    onRename: vi.fn(),
    onDuplicate: vi.fn(async () => {}),
    onDuplicateAndEdit: vi.fn(async () => {}),
    onDelete: vi.fn(),
    onDeleteVersion: vi.fn(),
    onImport: vi.fn(async () => ""),
    ...overrides,
  };
  act(() => root.render(<CompensationMatrices {...props} />));
  return props;
}

const versionItems = () => [...host.querySelectorAll<HTMLLIElement>(".gl-comp-lib-version")];
const toggle = () => host.querySelector<HTMLButtonElement>(".gl-comp-lib-versions-toggle");

describe("a matrix's versions", () => {
  it("lists them under the matrix in use, newest first, with what each was edited from", async () => {
    render(await lineageRows());
    expect(toggle()?.textContent).toBe("3 versions");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(versionItems().map((item) => item.querySelector(".gl-comp-lib-version-name")?.textContent)).toEqual([
      "Version 3", "Version 2", "Version 1",
    ]);
    expect(versionItems().map((item) => item.querySelector(".gl-comp-lib-meta")?.textContent?.split(" · ")[0])).toEqual([
      "Edited from version 2", "Edited from version 1", "Baseline",
    ]);
    expect(versionItems().map((item) => item.classList.contains("is-active"))).toEqual([true, false, false]);

    act(() => toggle()!.click());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(versionItems()).toHaveLength(0);
  });

  it("uses an earlier version for the workspace after the user agrees, and leaves the matrix as one row", async () => {
    const props = render(await lineageRows());
    const first = versionItems()[2];
    act(() => first.querySelector<HTMLButtonElement>(".gl-comp-version-use")!.click());
    const dialog = host.querySelector<HTMLElement>(".gl-comp-lib-switch")!;
    expect(dialog.textContent).toContain("Use M1 beads, version 1 for the workspace");
    act(() => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => {
      [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Use for the workspace")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(props.onUse).toHaveBeenCalledTimes(1);
    const used = vi.mocked(props.onUse!).mock.calls[0][0];
    expect(used.profile?.profileId).toBe("a");
    expect(used.matrix?.matrix).toEqual([[1, 0.1], [0.05, 1]]);
    // The version in use offers no switch to itself.
    expect(versionItems()[0].querySelector<HTMLButtonElement>(".gl-comp-version-use")!.disabled).toBe(true);
  });

  it("copies and exports any version, and deletes only one nothing depends on", async () => {
    const rows = await lineageRows();
    const props = render(rows);
    // Version 3 is in use, versions 1 and 2 were edited from: none can go.
    expect(versionItems().map((item) => item.querySelector(".gl-comp-version-delete") !== null)).toEqual([false, false, false]);

    await act(async () => {
      versionItems()[1].querySelector<HTMLButtonElement>(".gl-comp-version-duplicate")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const copied = vi.mocked(props.onDuplicate).mock.calls[0][0];
    expect(copied.profile?.profileId).toBe("a-e1");
    expect(copied.name).toBe("beads, version 2");

    act(() => versionItems()[1].querySelector<HTMLButtonElement>(".gl-comp-version-export")!.click());
    expect(host.querySelector('[aria-labelledby="comp-export-title"]')?.textContent).toContain("beads");

    // With version 1 in use instead, version 3 depends on nothing and no file uses it.
    const [row] = rows;
    const moved: MatrixVersionRow[] = row.versions.map((version) => ({
      ...version,
      active: version.version === 1,
      filesUsing: version.version === 1 ? 2 : 0,
      canDelete: version.version === 3,
    }));
    act(() => root.render(<CompensationMatrices {...props} rows={[{ ...row, versions: moved }]} />));
    act(() => versionItems()[0].querySelector<HTMLButtonElement>(".gl-comp-version-delete")!.click());
    const confirm = host.querySelector<HTMLElement>('[aria-labelledby="comp-version-delete-title"]')!;
    expect(confirm.textContent).toContain("Delete M1 beads, version 3?");
    act(() => [...confirm.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Delete")!.click());
    expect(vi.mocked(props.onDeleteVersion!).mock.calls[0][0].profile?.profileId).toBe("a-e2");
  });

  it("hands Import to the tab where the tab imports (a CyTOF matrix)", async () => {
    const chooseImport = vi.fn();
    render(await lineageRows(), { chooseImport });
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Import CSV/TSV…")!.click());
    expect(chooseImport).toHaveBeenCalledTimes(1);
  });
});
