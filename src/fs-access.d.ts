// Ambient declarations for the File System Access API (Chromium) — not yet in the default
// TS DOM lib. Only the surface GateLab uses.

interface FileSystemFileHandle {
  queryPermission?(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}
interface OpenFilePickerOptions {
  types?: FilePickerAcceptType[];
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
}
interface SaveFilePickerOptions {
  types?: FilePickerAcceptType[];
  suggestedName?: string;
  excludeAcceptAllOption?: boolean;
}

interface Window {
  showOpenFilePicker?(opts?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(opts?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}
