// Synthetic files for the placed-image tests: the headers of a PNG and a JPEG of a given size, and
// a hostile SVG that tries every way of running code or reaching outside the file. The hosts are
// example.org; the labels D1 and control are synthetic.

/** The first bytes of a PNG of `width` × `height`: the signature and the IHDR chunk. */
export function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

/** The first bytes of a JPEG of `width` × `height`: SOI, an APP0 segment, then the frame header. */
export function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

/** A hostile SVG: a script, foreignObject, handlers, outside references of every kind, animation that sets a link. */
export const HOSTILE_SVG = `<?xml version="1.0"?>
<?xml-stylesheet href="https://example.org/sheet.css"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="60" viewBox="0 0 120 60" onload="alert(1)">
  <style>@import url("https://example.org/x.css"); .cls-1 { fill: #336699; } #grad-stop { stop-color: #ff0000; } rect { background: url(https://example.org/t.png); }</style>
  <script>alert(2)</script>
  <script xlink:href="https://example.org/evil.js"/>
  <defs><linearGradient id="grad"><stop id="grad-stop" offset="0"/></linearGradient></defs>
  <rect id="box" class="cls-1" width="120" height="60" onclick="alert(3)" OnMouseOver="alert(4)" fill="url(#grad)" filter="url(https://example.org/f.svg#f)"/>
  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://example.org"/></div></foreignObject>
  <a href="javascript:alert(5)"><text x="4" y="20">D1</text></a>
  <a xlink:href="https://example.org"><text x="4" y="40">control</text></a>
  <image href="https://example.org/track.png" width="1" height="1"/>
  <image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>
  <use href="#box" x="2"/>
  <use xlink:href="other.svg#box"/>
  <set attributeName="href" to="javascript:alert(6)"/>
  <animate attributeName="href" values="javascript:alert(7)"/>
</svg>`;
