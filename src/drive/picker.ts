// picker.ts — Google's file picker, the only way a lab member gives GateLab a file it did not make:
// under the drive.file scope a file is reachable once picked, and a picked folder shows GateLab
// none of what it holds. The Picker's key is restricted by referrer, so the page must send its
// origin to Google (the lab site's Referrer-Policy is strict-origin-when-cross-origin, not no-referrer).

import { DriveError } from "./api";
import type { DriveConfig } from "./config";
import { loadScript } from "./loadScript";

const GAPI_SRC = "https://apis.google.com/js/api.js";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** What the Picker says was picked. Only the ID is trusted, and only once Drive confirms it. */
export interface PickedDoc {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
}

export interface DrivePicker {
  /** The files of one experiment: the Picker opens in the lab folder, folders navigable, several files selectable. */
  pickExperimentFiles(): Promise<PickedDoc[] | null>;
  /** The files a workspace still needs, picked from its experiment folder. */
  pickMissing(folderId: string, names: readonly string[]): Promise<PickedDoc[] | null>;
  /**
   * A folder: an experiment folder, or a folder above one, chosen in the lab folder (so GateLab may
   * create a file in it, or read where it is); the place for a new experiment, chosen in the lab
   * folder; or the lab folder itself, chosen from the Shared drives above it. `title` replaces the
   * picker's own for an experiment folder.
   */
  pickFolder(kind?: "experiment" | "lab" | "location", title?: string): Promise<PickedDoc | null>;
}

/* The parts of the Picker API used here. */
interface PickerDocsView {
  setEnableDrives(on: boolean): PickerDocsView;
  setIncludeFolders(on: boolean): PickerDocsView;
  setSelectFolderEnabled(on: boolean): PickerDocsView;
  setMimeTypes(types: string): PickerDocsView;
  setParent(id: string): PickerDocsView;
  setMode(mode: unknown): PickerDocsView;
}
interface PickerBuilder {
  setAppId(id: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  addView(view: PickerDocsView): PickerBuilder;
  enableFeature(feature: unknown): PickerBuilder;
  setCallback(callback: (data: { action: string; docs?: { id: string; name?: string; mimeType?: string }[] }) => void): PickerBuilder;
  build(): { setVisible(on: boolean): void; dispose?(): void };
}
interface PickerNamespace {
  DocsView: new () => PickerDocsView;
  DocsViewMode: { LIST: unknown };
  PickerBuilder: new () => PickerBuilder;
  Feature: { MULTISELECT_ENABLED: unknown; SUPPORT_DRIVES: unknown };
  Action: { PICKED: string; CANCEL: string };
}

let pickerLoaded: Promise<PickerNamespace> | null = null;

function loadPicker(): Promise<PickerNamespace> {
  pickerLoaded ??= loadScript(GAPI_SRC).then(() => new Promise<PickerNamespace>((resolve, reject) => {
    const gapi = (window as unknown as { gapi?: { load(name: string, callback: () => void): void } }).gapi;
    if (!gapi) {
      reject(new DriveError("Google's file picker did not load."));
      return;
    }
    gapi.load("picker", () => {
      const picker = (window as unknown as { google?: { picker?: PickerNamespace } }).google?.picker;
      if (picker) resolve(picker);
      else reject(new DriveError("Google's file picker did not load."));
    });
  })).catch((cause) => {
    pickerLoaded = null;
    throw cause;
  });
  return pickerLoaded;
}

export function createDrivePicker(config: DriveConfig, token: () => string): DrivePicker {
  const open = async (options: {
    title: string;
    /** The folder the picker opens in; null for the top, with the Shared drives. */
    parentId: string | null;
    multiselect: boolean;
    folders: boolean;
  }): Promise<PickedDoc[] | null> => {
    const bearer = token();
    const picker = await loadPicker();
    return new Promise((resolve) => {
      const view = new picker.DocsView()
        .setEnableDrives(true)
        .setIncludeFolders(true)
        .setMode(picker.DocsViewMode.LIST);
      if (options.parentId) view.setParent(options.parentId);
      if (options.folders) view.setSelectFolderEnabled(true).setMimeTypes(FOLDER_MIME);
      const builder = new picker.PickerBuilder()
        .setAppId(config.appId)
        .setOAuthToken(bearer)
        .setDeveloperKey(config.apiKey)
        .setOrigin(window.location.origin)
        .setTitle(options.title)
        .addView(view)
        .enableFeature(picker.Feature.SUPPORT_DRIVES)
        .setCallback((data) => {
          if (data.action === picker.Action.PICKED) {
            resolve((data.docs ?? []).map((doc) => ({ id: String(doc.id), name: String(doc.name ?? ""), mimeType: String(doc.mimeType ?? "") })));
          } else if (data.action === picker.Action.CANCEL) {
            resolve(null);
          }
        });
      if (options.multiselect) builder.enableFeature(picker.Feature.MULTISELECT_ENABLED);
      builder.build().setVisible(true);
    });
  };

  return {
    pickExperimentFiles: () => open({
      title: "Open an experiment: open its folder, select all its files (Shift-click), then Select",
      parentId: config.rootFolderId,
      multiselect: true,
      folders: false,
    }),
    pickMissing: (folderId, names) => open({
      title: `Select the files this workspace still needs: ${names.join(", ")}`.slice(0, 250),
      parentId: folderId,
      multiselect: true,
      folders: false,
    }),
    pickFolder: async (kind = "experiment", title) => {
      const docs = await open(kind === "lab"
        ? {
            title: "Choose the lab folder (the one that holds the experiment folders), so GateLab may make a new experiment in it",
            parentId: null,
            multiselect: false,
            folders: true,
          }
        : kind === "location"
          ? {
              title: "Choose where the new experiment goes: a folder in the lab folder (open folders to go deeper, then select one)",
              parentId: config.rootFolderId,
              multiselect: false,
              folders: true,
            }
          : {
              title: title ?? "Choose the experiment folder to save the workspace in",
              parentId: config.rootFolderId,
              multiselect: false,
              folders: true,
            });
      return docs?.[0] ?? null;
    },
  };
}
