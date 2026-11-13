// LayoutPlacedImage.tsx — placed images on the Layout tab: the image on the page (always an <img>
// of a data URL, so a placed SVG runs nothing), "+ Image…" in the toolbar and the page's menu, a
// file dropped on the page, and the inspector's file name, natural size, stored size and
// "Replace…". Reading the file and making an SVG safe are in placedImage.ts.

import { useMemo, useRef, type DragEvent } from "react";
import type { LayoutPlacedImageRecipe } from "../../engine/placedImageBlock";
import type { MenuEntry } from "../MenuButton";
import { useI18n } from "../i18n";
import { formatBytes, pickImageFile, placedImageSrc, readPlacedImage, storedBytes, type PlacedImageRead } from "./placedImage";
import "./layoutPlacedImage.css";

type Translate = (source: string, values?: Readonly<Record<string, string | number>>) => string;
type Point = { x: number; y: number };

/** The image on the page, stretched to its frame. */
export function LayoutPlacedImageView({ recipe }: Readonly<{ recipe: LayoutPlacedImageRecipe }>) {
  const src = useMemo(() => placedImageSrc(recipe), [recipe]);
  return <img className="gl-layout-placed-image" src={src} alt={recipe.fileName} draggable={false} data-media-type={recipe.mediaType} />;
}

/**
 * Read a file as a placed image and hand the result, with `target` (where it goes, or what it
 * replaces), to the latest `onRead`: reading takes a moment, and the page may have changed.
 */
export function usePlacedImageFile<T>(onRead: (read: PlacedImageRead, target: T) => void): (file: File, target: T) => void {
  const { t } = useI18n();
  const latest = useRef(onRead);
  latest.current = onRead;
  const translate = useRef(t);
  translate.current = t;
  return useRef((file: File, target: T) => {
    void readPlacedImage(file, translate.current).then((read) => latest.current(read, target));
  }).current;
}

/** The toolbar's "+ Image…": the system's file picker for an SVG, PNG or JPEG. */
export function LayoutImageButton({ onFile }: Readonly<{ onFile: (file: File) => void }>) {
  const { t } = useI18n();
  return (
    <button
      className="gl-mini-btn"
      type="button"
      title={t("Place an SVG, PNG or JPEG file on the page, kept in the workspace; or drop the file on the page")}
      onClick={() => void pickImageFile().then((file) => file && onFile(file))}
    >
      {t("+ Image…")}
    </button>
  );
}

/** The blank page's menu entry for an image, placed where the menu was opened. */
export function imageMenuEntry(t: Translate, onFile: (file: File) => void): MenuEntry {
  return { label: t("+ Image…"), onClick: () => void pickImageFile().then((file) => file && onFile(file)) };
}

/** The page's handlers for a file dropped on it: an image, placed with its top-left corner at the drop point (page px). */
export function placedImageDrop(zoom: number, onFile: (file: File, at: Point) => void) {
  const carriesFiles = (event: DragEvent<HTMLElement>) => [...(event.dataTransfer?.types ?? [])].includes("Files");
  return {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onFile(file, { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom });
    },
  };
}

const TYPE_WORDS: Record<LayoutPlacedImageRecipe["mediaType"], string> = { "image/svg+xml": "SVG", "image/png": "PNG", "image/jpeg": "JPEG" };

/** The inspector for a placed image: what file it is, its sizes, and "Replace…", which keeps its frame. */
export function LayoutImageInspector({ recipe, onReplace }: Readonly<{ recipe: LayoutPlacedImageRecipe; onReplace: (file: File) => void }>) {
  const { t } = useI18n();
  return (
    <div className="gl-layout-image-fields" aria-label={t("Image")}>
      <dl>
        <dt>{t("File")}</dt>
        <dd className="gl-layout-image-file">{recipe.fileName} ({TYPE_WORDS[recipe.mediaType]})</dd>
        <dt>{t("Natural size")}</dt>
        <dd className="gl-layout-image-natural">{t("{width} × {height} px", { width: recipe.naturalWidth, height: recipe.naturalHeight })}</dd>
        <dt>{t("Stored size")}</dt>
        <dd className="gl-layout-image-stored">{formatBytes(storedBytes(recipe))}</dd>
      </dl>
      <button
        type="button"
        className="gl-mini-btn"
        title={t("Take another SVG, PNG or JPEG file in place of this one, in the same frame")}
        onClick={() => void pickImageFile().then((file) => file && onReplace(file))}
      >
        {t("Replace…")}
      </button>
    </div>
  );
}
