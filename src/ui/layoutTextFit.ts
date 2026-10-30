/**
 * The frame a Layout text block needs to show its text whole, measured as the Layout tab draws
 * it: the static text surface (its font, padding, line height and wrapping at spaces) inside the
 * item's one-pixel border. The width is the text's own up to `maxWidth`; past that the text wraps
 * and the height grows, and a word longer than `maxWidth` widens the frame to hold it. Null where
 * nothing is laid out (no layout engine, as under jsdom), so the caller keeps its own size.
 */
export function fitLayoutText(
  text: string,
  fontSize: number,
  maxWidth: number,
  bold = false,
): { width: number; height: number } | null {
  if (typeof document === "undefined" || !document.body) return null;
  const surface = document.createElement("div");
  surface.className = "gl-layout-text-surface is-static";
  surface.textContent = text;
  Object.assign(surface.style, {
    position: "fixed", left: "-10000px", top: "0", visibility: "hidden",
    width: "max-content", height: "auto", flex: "none",
    fontSize: `${fontSize}px`, fontWeight: bold ? "700" : "400",
  });
  document.body.appendChild(surface);
  try {
    let width = surface.getBoundingClientRect().width;
    if (!(width > 0)) return null;
    if (width > maxWidth) {
      surface.style.width = `${maxWidth}px`;
      width = Math.max(maxWidth, surface.scrollWidth);
      surface.style.width = `${width}px`;
    }
    const height = Math.max(surface.getBoundingClientRect().height, surface.scrollHeight);
    // The item's border is outside the surface; the extra pixel absorbs subpixel text widths.
    const border = 2;
    return { width: Math.ceil(width) + border + 1, height: Math.ceil(height) + border };
  } finally {
    surface.remove();
  }
}
