// Safari on an iPhone or iPad zooms the page in when a control whose text is under 16 px takes
// focus, and leaves it zoomed: a tap on a channel select or a number field during a demonstration
// leaves the plot half off the screen. A viewport with maximum-scale=1 stops that zoom, and Safari
// still lets the user pinch to zoom, since it has ignored maximum-scale for gestures from iOS 10.
// Other browsers read maximum-scale as a ban on pinch-zoom, so it is set on Apple touch devices only.

/** True on an iPhone, iPod or iPad, whichever site the browser asks for. */
export function isAppleTouchDevice(nav: Pick<Navigator, "userAgent" | "maxTouchPoints">): boolean {
  if (/\b(iPhone|iPad|iPod)\b/.test(nav.userAgent)) return true;
  // iPadOS asks for desktop sites and names itself a Mac; only its touch points tell it apart.
  return /\bMacintosh\b/.test(nav.userAgent) && nav.maxTouchPoints > 1;
}

/** The viewport content with maximum-scale=1 added, unless it already sets a maximum scale. */
export function viewportWithoutFocusZoom(content: string): string {
  if (/maximum-scale\s*=/.test(content)) return content;
  return `${content.trim().replace(/,\s*$/, "")}, maximum-scale=1`;
}

/** On an Apple touch device, stops Safari zooming in on a focused control. */
export function holdFocusZoomOnAppleTouch(doc: Document = document, nav: Navigator = navigator): void {
  if (!isAppleTouchDevice(nav)) return;
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta) meta.content = viewportWithoutFocusZoom(meta.content);
}
