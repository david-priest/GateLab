import { mountGateLab } from "./bootstrap";
import { holdFocusZoomOnAppleTouch } from "./ui/iosViewport";

holdFocusZoomOnAppleTouch();

const container = document.getElementById("root");
if (!container) throw new Error("GateLab root container was not found.");

const mountedGateLab = mountGateLab(container);
if (import.meta.hot) import.meta.hot.dispose(() => mountedGateLab.unmount());
