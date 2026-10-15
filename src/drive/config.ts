// config.ts — the lab build's Google Drive configuration, from the VITE_GATELAB_DRIVE_* values the
// build was given (vite.config.ts compiles src/drive in only when all five are set). None of them is
// a secret: the client ID and the Picker key are restricted to the lab site's origin in Google
// Cloud, and the folder ID reaches nothing without a lab member's own sign-in.

export interface DriveConfig {
  /** OAuth client of the lab's Internal app, in a Google Cloud project of the institution's organisation. */
  readonly clientId: string;
  /** Browser key for the Google Picker, restricted by HTTP referrer to the lab site. */
  readonly apiKey: string;
  /** The Cloud project number: the Picker grants picked files to this app. */
  readonly appId: string;
  /** The lab folder the Picker opens in. */
  readonly rootFolderId: string;
  /** The Workspace domain sign-in is offered for, and the only one accepted. */
  readonly domain: string;
}

export interface DriveConfigSource {
  readonly clientId?: string;
  readonly apiKey?: string;
  readonly appId?: string;
  readonly rootFolderId?: string;
  readonly domain?: string;
}

/** A Drive file or folder ID: what is put into a request path or a query, and nothing else is. */
export const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** The configuration, or null when any value is missing or malformed. */
export function readDriveConfig(source: DriveConfigSource = {
  clientId: import.meta.env.VITE_GATELAB_DRIVE_CLIENT_ID,
  apiKey: import.meta.env.VITE_GATELAB_DRIVE_API_KEY,
  appId: import.meta.env.VITE_GATELAB_DRIVE_APP_ID,
  rootFolderId: import.meta.env.VITE_GATELAB_DRIVE_ROOT_ID,
  domain: import.meta.env.VITE_GATELAB_DRIVE_DOMAIN,
}): DriveConfig | null {
  const clientId = source.clientId?.trim() ?? "";
  const apiKey = source.apiKey?.trim() ?? "";
  const appId = source.appId?.trim() ?? "";
  const rootFolderId = source.rootFolderId?.trim() ?? "";
  const domain = source.domain?.trim().toLowerCase() ?? "";
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) return null;
  if (!/^[A-Za-z0-9_-]{20,}$/.test(apiKey)) return null;
  if (!/^[0-9]+$/.test(appId)) return null;
  if (!DRIVE_ID.test(rootFolderId)) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  return Object.freeze({ clientId, apiKey, appId, rootFolderId, domain });
}
