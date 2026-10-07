// @vitest-environment jsdom
// The Chorus dialog with a .cef but none of its recordings loaded: it says so, and offers the file
// picker, since the recordings and their gates appear only once their FCS files are in.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChorusExperiment } from "../engine/chorusExperiment";
import { buildChorusTimeline } from "../engine/chorusTimeline";
import { ChorusTimelineModal } from "./ChorusTimelineModal";
import { I18nProvider } from "./i18n";

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

function experiment(recordingCount: number | null, sorts: ChorusExperiment["sorts"] = []): ChorusExperiment {
  return {
    id: "exp-1", name: "synthetic sort", recordingCount, savedAt: "2026-01-02T12:00:00", chorusVersion: "6.3.0",
    panels: [{ id: "panel-1", name: "Panel 1", gates: [], rValues: new Map(), detectors: new Map() }],
    sorts,
  };
}

describe("the Chorus dialog with no recording loaded", () => {
  it("says the recordings' FCS files come first, and opens the picker", () => {
    const onAddFiles = vi.fn();
    const exp = experiment(5);
    act(() => root.render(
      <I18nProvider>
        <ChorusTimelineModal
          experimentName={exp.name}
          timeline={buildChorusTimeline(exp, [])}
          hasSample={false}
          onImportTree={vi.fn()}
          onImportRecordings={vi.fn()}
          onAddFiles={onAddFiles}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    ));
    const note = host.querySelector(".gl-chorus-empty");
    expect(note?.textContent).toContain("None of this experiment's 5 recordings is loaded");
    expect(note?.textContent).toContain("Load the recordings' FCS files first");
    act(() => (host.querySelector(".gl-chorus-add-files") as HTMLButtonElement).click());
    expect(onAddFiles).toHaveBeenCalledTimes(1);
  });

  it("is silent once a recording is loaded, and without the picker shows no button", () => {
    const exp = experiment(null);
    act(() => root.render(
      <I18nProvider>
        <ChorusTimelineModal
          experimentName={exp.name}
          timeline={buildChorusTimeline(exp, [])}
          hasSample={false}
          onImportTree={vi.fn()}
          onImportRecordings={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    ));
    expect(host.querySelector(".gl-chorus-empty")?.textContent).toContain("No recording of this experiment is loaded");
    expect(host.querySelector(".gl-chorus-add-files")).toBeNull();
  });
});

describe("the timeline strip's labels", () => {
  it("names each sort with its span and what it sorted, and the current gates with their save time", () => {
    const exp = experiment(3, [
      { name: "Sort_002", startedAt: "2026-01-02T10:00:00", stoppedAt: "2026-01-02T10:20:00", gates: [], totalEvents: 5000, destinations: [{ population: "Singlets", sortCount: 900, targetCount: 1000 }] },
    ]);
    act(() => root.render(
      <I18nProvider>
        <ChorusTimelineModal
          experimentName={exp.name}
          timeline={buildChorusTimeline(exp, [])}
          hasSample={false}
          onImportTree={vi.fn()}
          onImportRecordings={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    ));
    const svg = host.querySelector(".gl-chorus-timeline-strip")!;
    const texts = [...svg.querySelectorAll("text")].map((e) => e.textContent);
    expect(texts.some((x) => /^sort · Sort_002 · \d\d:\d\d–\d\d:\d\d$/.test(x ?? ""))).toBe(true);
    expect(texts.some((x) => /^sorted Singlets/.test(x ?? ""))).toBe(true);
    expect(texts.some((x) => /^current gates saved \d\d:\d\d$/.test(x ?? ""))).toBe(true);
    // Quarter-hour ticks on a span of a few hours.
    expect(texts.filter((x) => /^\d\d:(00|15|30|45)$/.test(x ?? "")).length).toBeGreaterThanOrEqual(4);
  });
});
