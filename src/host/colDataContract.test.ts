import { packMembershipBits } from "./colDataContract";

describe("packMembershipBits", () => {
  it("packs masks LSB-first and preserves partial trailing bytes", () => {
    expect([
      ...packMembershipBits(Uint8Array.from([
        1, 0, 1, 1, 0, 0, 0, 1,
        0, 1,
      ])),
    ]).toEqual([0b10001101, 0b00000010]);
  });

  it("treats every non-zero mask value as a member", () => {
    expect([...packMembershipBits(Uint8Array.from([0, 2, 0, 255]))])
      .toEqual([0b00001010]);
  });
});
