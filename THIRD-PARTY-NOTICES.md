# Third-party notices

GateLab is distributed with the third-party components below. GateLab itself is MIT-licensed
(see [LICENSE](LICENSE)); the bundled components are distributed under their own licenses.

Most are MIT, but note **DOMPurify is MPL-2.0 / Apache-2.0** (pulled in transitively by jsPDF).

## Runtime dependencies (present in the production bundle)

| Component | Version | License | Copyright |
|---|---|---|---|
| react | 18.3.1 | MIT | © Meta Platforms, Inc. and affiliates |
| react-dom | 18.3.1 | MIT | © Meta Platforms, Inc. and affiliates |
| jspdf | 4.2.1 | MIT | © James Hall, yWorks GmbH, and contributors |
| fflate | 0.8.3 | MIT | © Arjun Barrett |
| canvg | 3.0.11 | MIT | © Gabe Lerner and contributors (via jsPDF) |
| html2canvas | 1.4.1 | MIT | © Niklas von Hertzen (via jsPDF) |
| **dompurify** | 3.4.11 | **MPL-2.0 OR Apache-2.0** | © Cure53 and contributors (via jsPDF) |
| raf | 3.4.1 | MIT | © Chris Dickinson (via jsPDF) |
| rgbcolor | 1.0.1 | MIT | © Stoyan Stefanov (via jsPDF) |

canvg, html2canvas, dompurify, raf and rgbcolor are transitive dependencies of jsPDF. They are
emitted as separate lazy-loaded chunks and are only fetched at runtime if jsPDF's HTML/SVG code
paths are exercised; GateLab's own PDF export rasterizes SVG to a canvas and uses
`jsPDF.addImage`, which does not require them, but they are present in the distributed `dist/`.

## Vendored components

| Component | Version | License | Copyright |
|---|---|---|---|
| D3 | 7 (`vendor/GateLabR/inst/app/www/d3.v7.min.js`) | ISC | © Mike Bostock |
| GateLabR D3 plot modules | — (`vendor/GateLabR/inst/app/www/{cytof,mini,division}_plot.js`) | MIT | © 2026 David G. Priest (license retained at `vendor/GateLabR/LICENSE`) |

Full license texts are available in each package's directory under `node_modules/` and, for the
vendored GateLabR modules, at `vendor/GateLabR/LICENSE`.
