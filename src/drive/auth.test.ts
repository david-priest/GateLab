// Sign-in to the lab Drive: only an account of the lab's domain is kept, a token near its end is
// not used, and sign-out drops the token without revoking it. Synthetic accounts.

import { describe, expect, it } from "vitest";
import { DriveAuthError } from "./api";
import { createDriveAuth, DRIVE_SCOPE, TOKEN_MARGIN_MS, type GisOAuth2 } from "./auth";
import { FAKE_CONFIG } from "./testFakeDrive";

function fakeGis(granted = true) {
  const requested: unknown[] = [];
  let client: { callback: (response: object) => void } | null = null;
  const gis: GisOAuth2 = {
    initTokenClient(config) {
      requested.push(config);
      client = {
        callback: config.callback,
        requestAccessToken: () => client!.callback({ access_token: "token-1", expires_in: 3600, scope: DRIVE_SCOPE }),
      } as never;
      return client as never;
    },
    hasGrantedAllScopes: () => granted,
  };
  return { gis, requested };
}

const about = (email: string) => (async () => Response.json({ user: { emailAddress: email, displayName: "Member One" } })) as typeof fetch;

describe("lab Drive sign-in", () => {
  it("keeps a lab account's token, and drops it at sign-out", async () => {
    let now = 1_000_000;
    const { gis, requested } = fakeGis();
    const auth = createDriveAuth(FAKE_CONFIG, { loadGis: async () => gis, fetchImpl: about("member1@lab.example.org"), now: () => now });
    expect(() => auth.token()).toThrow(DriveAuthError);
    const account = await auth.signIn();
    expect(account.email).toBe("member1@lab.example.org");
    expect(requested[0]).toMatchObject({ client_id: FAKE_CONFIG.clientId, scope: DRIVE_SCOPE, hd: "lab.example.org" });
    expect(auth.token()).toBe("token-1");
    // Within two minutes of running out, the token is not used.
    now += 3600_000 - TOKEN_MARGIN_MS + 1;
    expect(() => auth.token()).toThrow(DriveAuthError);
    expect(auth.account()?.email).toBe("member1@lab.example.org");
    auth.signOut();
    expect(auth.account()).toBeNull();
    expect(() => auth.token()).toThrow(DriveAuthError);
  });

  it("refuses an account of another domain", async () => {
    const { gis } = fakeGis();
    const auth = createDriveAuth(FAKE_CONFIG, { loadGis: async () => gis, fetchImpl: about("someone@gmail.com") });
    await expect(auth.signIn()).rejects.toThrow(/lab\.example\.org accounts only/);
    expect(() => auth.token()).toThrow(DriveAuthError);
  });

  it("refuses a sign-in that did not grant access to the files picked", async () => {
    const { gis } = fakeGis(false);
    const auth = createDriveAuth(FAKE_CONFIG, { loadGis: async () => gis, fetchImpl: about("member1@lab.example.org") });
    await expect(auth.signIn()).rejects.toThrow(/did not give GateLab access/);
  });
});
