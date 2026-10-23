// auth.ts — signing a lab member in to the lab Drive with Google Identity Services. The access
// token lives in this module's closure only: never React state, storage or a URL, and it is sent
// only in the Authorization header. GIS gives no refresh token, so a token that runs out (after
// an hour) takes a click on Reconnect, which keeps the member signed in: another account is
// refused there, so a workspace opened as one member is never saved as another. Sign-out drops
// the token; it does not call revoke, whose effect on the files a member has picked for GateLab is
// untested.

import { DriveAuthError, DriveError } from "./api";
import type { DriveConfig } from "./config";
import { loadScript } from "./loadScript";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GIS_SRC = "https://accounts.google.com/gsi/client";
/** A token this close to running out is not used: a save or a download could outlast it. */
export const TOKEN_MARGIN_MS = 2 * 60 * 1000;

interface GisTokenResponse {
  access_token?: string;
  expires_in?: string | number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  callback: (response: GisTokenResponse) => void;
  error_callback?: (error: { type?: string; message?: string }) => void;
  requestAccessToken(overrides?: { prompt?: string; hint?: string }): void;
}

export interface GisOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    hd?: string;
    prompt?: string;
    callback: (response: GisTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): GisTokenClient;
  hasGrantedAllScopes(response: GisTokenResponse, ...scopes: string[]): boolean;
}

export async function loadGis(): Promise<GisOAuth2> {
  await loadScript(GIS_SRC);
  const oauth2 = (window as unknown as { google?: { accounts?: { oauth2?: GisOAuth2 } } }).google?.accounts?.oauth2;
  if (!oauth2) throw new DriveError("Google sign-in did not load.");
  return oauth2;
}

export interface DriveAccount {
  readonly email: string;
  readonly name: string | null;
}

export interface DriveAuth {
  /** Load Google's sign-in library ahead of the click that signs in, so its window is not blocked. */
  prepare(): Promise<void>;
  /** Sign in. Call it from a click. */
  signIn(): Promise<DriveAccount>;
  /**
   * A new token for the member signed in, once theirs has run out; another account is refused and
   * the sign-in stays as it was. Signs in when nobody is. Call it from a click.
   */
  reconnect(): Promise<DriveAccount>;
  signOut(): void;
  /** The token for one request; throws DriveAuthError when there is none or it is about to run out. */
  token(): string;
  account(): DriveAccount | null;
  /** When the token runs out (ms since the epoch), or null when signed out. */
  expiresAt(): number | null;
  /** Called on sign-in, sign-out, and when the token comes within the margin of running out. */
  subscribe(listener: () => void): () => void;
}

/** Whether the token can be used now: signed in, and not within TOKEN_MARGIN_MS of running out. */
export function tokenLive(auth: DriveAuth): boolean {
  try {
    auth.token();
    return true;
  } catch {
    return false;
  }
}

export interface DriveAuthDeps {
  readonly loadGis: () => Promise<GisOAuth2>;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
}

export function createDriveAuth(config: DriveConfig, deps: Partial<DriveAuthDeps> = {}): DriveAuth {
  const load = deps.loadGis ?? loadGis;
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = deps.now ?? (() => Date.now());

  let token: string | null = null;
  let expiry = 0;
  let account: DriveAccount | null = null;
  let client: GisTokenClient | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };

  const clear = () => {
    token = null;
    expiry = 0;
    account = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const ensureClient = async (): Promise<GisTokenClient> => {
    if (client) return client;
    const oauth2 = await load();
    client = oauth2.initTokenClient({
      client_id: config.clientId,
      scope: DRIVE_SCOPE,
      hd: config.domain,
      prompt: "",
      callback: () => undefined,
    });
    return client;
  };

  const requestToken = async (): Promise<{ token: string; expiresIn: number }> => {
    const tokenClient = await ensureClient();
    const oauth2 = await load();
    return new Promise((resolve, reject) => {
      tokenClient.callback = (response) => {
        if (response.error || !response.access_token) {
          reject(new DriveAuthError(`Sign-in was not completed (${response.error ?? "no token"}${response.error_description ? `: ${response.error_description}` : ""}).`));
          return;
        }
        if (!oauth2.hasGrantedAllScopes(response, DRIVE_SCOPE)) {
          reject(new DriveAuthError("Sign-in did not give GateLab access to the files you choose in the lab Drive, which it needs to open and save experiments."));
          return;
        }
        resolve({ token: response.access_token, expiresIn: Number(response.expires_in) || 3600 });
      };
      tokenClient.error_callback = (error) => {
        reject(new DriveAuthError(
          error.type === "popup_failed_to_open"
            ? "The browser blocked Google's sign-in window. Allow pop-ups for this site, then sign in again."
            : error.type === "popup_closed"
              ? "The sign-in window was closed before signing in."
              : `Sign-in failed (${error.type ?? "unknown"}${error.message ? `: ${error.message}` : ""}).`,
        ));
      };
      tokenClient.requestAccessToken(account ? { prompt: "", hint: account.email } : { prompt: "" });
    });
  };

  /** A token, and who it is for; `expected` is the member a reconnect must be. */
  const connect = async (expected: string | null): Promise<DriveAccount> => {
    const granted = await requestToken();
    // A reconnect that fails leaves the member signed in, with the token that ran out.
    const refuse = (error: DriveError): never => {
      if (expected === null) {
        clear();
        notify();
      }
      throw error;
    };
    // Who signed in, and that it is a lab account: the client is Internal to the university's
    // Workspace already, and this refuses any other account outright.
    const response = await fetchImpl("https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)", {
      headers: { Authorization: `Bearer ${granted.token}` },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) return refuse(new DriveError(`Signed in, but Drive refused to say who (HTTP ${response.status}).`, response.status));
    const user = ((await response.json()) as { user?: { displayName?: unknown; emailAddress?: unknown } }).user ?? {};
    const email = typeof user.emailAddress === "string" ? user.emailAddress : "";
    if (!email.toLowerCase().endsWith(`@${config.domain}`)) {
      return refuse(new DriveAuthError(`The lab Drive takes ${config.domain} accounts only; ${email || "this account"} is not one.`));
    }
    if (expected !== null && email.toLowerCase() !== expected.toLowerCase()) {
      return refuse(new DriveAuthError(
        `Google reconnected ${email}, but the lab Drive here is signed in as ${expected}. Reconnect as ${expected}, ` +
          "or sign out first to change account; nothing open here is lost.",
      ));
    }
    token = granted.token;
    expiry = now() + granted.expiresIn * 1000;
    account = Object.freeze({ email, name: typeof user.displayName === "string" ? user.displayName : null });
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(notify, Math.max(0, expiry - TOKEN_MARGIN_MS - now()));
    notify();
    return account;
  };

  return {
    async prepare() {
      await ensureClient();
    },

    signIn: () => connect(null),
    reconnect: () => connect(account?.email ?? null),

    signOut() {
      clear();
      notify();
    },

    token() {
      if (!token) throw new DriveAuthError("Sign in to the lab Drive first (Lab Drive ▸ Sign in).");
      if (now() > expiry - TOKEN_MARGIN_MS) throw new DriveAuthError();
      return token;
    },

    account: () => account,
    expiresAt: () => (token ? expiry : null),

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
