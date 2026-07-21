import { describe, expect, it } from "vitest";
import {
  cytofInteractionType,
  cytofMatrixForDisplay,
  orderCytofChannels,
  parseCytofIsotope,
} from "./compensationMatrixView";
import type { CanonicalCompensationMatrix } from "./compensationProfile";

describe("CyTOF compensation-matrix presentation", () => {
  it("parses both FCS isotope naming conventions without mistaking flow labels for masses", () => {
    expect(parseCytofIsotope("Cd106Di")).toEqual({ element: "Cd", mass: 106 });
    expect(parseCytofIsotope("106Cd_CD32")).toEqual({ element: "Cd", mass: 106 });
    expect(parseCytofIsotope("89Y_CD45 (Y89Di)")).toEqual({ element: "Y", mass: 89 });
    expect(parseCytofIsotope("FL1-A")).toBeNull();
  });

  it("orders isotopes by mass, then element, while leaving unparsed identities stable at the end", () => {
    const channels = ["Bi209Di", "Cd110Di", "Time", "Y89Di", "Yb176Di", "Lu176Di"];
    expect(orderCytofChannels(channels).map((index) => channels[index])).toEqual([
      "Y89Di", "Cd110Di", "Lu176Di", "Yb176Di", "Bi209Di", "Time",
    ]);
  });

  it("mass-orders each rectangular axis independently without moving a coefficient to another pair", () => {
    const input: CanonicalCompensationMatrix = {
      schema: "gatelab.compensation-matrix.v1",
      orientation: "source-rows-receiver-columns",
      sourceChannels: ["Nd142Di", "Cd106Di"],
      receiverChannels: ["Gd158Di", "Cd107Di", "Nd143Di", "Cd106Di"],
      matrix: [
        [0.16, 0, 0.01, 0],
        [0, 0.02, 0, 1],
      ],
    };
    const view = cytofMatrixForDisplay(input);
    expect(view.sourceChannels).toEqual(["Cd106Di", "Nd142Di"]);
    expect(view.receiverChannels).toEqual(["Cd106Di", "Cd107Di", "Nd143Di", "Gd158Di"]);
    expect(view.matrix).toEqual([
      [1, 0.02, 0, 0],
      [0, 0, 0.01, 0.16],
    ]);
  });

  it("classifies the physical offsets used by plot_spill", () => {
    expect(cytofInteractionType("Cd106Di", "Cd106Di")).toBe("self");
    expect(cytofInteractionType("Cd110Di", "Cd111Di")).toBe("M+1");
    expect(cytofInteractionType("Nd142Di", "Pr141Di")).toBe("M-1");
    expect(cytofInteractionType("Nd142Di", "Nd143Di")).toBe("M+1");
    expect(cytofInteractionType("Nd142Di", "Ce143Di")).toBe("M+1");
    expect(cytofInteractionType("Nd142Di", "Gd158Di")).toBe("oxide (+16)");
    expect(cytofInteractionType("Nd142Di", "Bi209Di")).toBe("other");
  });
});
