/// <reference types="vite/client" />

// The reused GateLabR D3 modules are loaded as raw source strings and eval'd in
// global scope (they attach window.d3 / window.CytofD3 and register on window.Shiny).
declare module "*.js?raw" {
  const src: string;
  export default src;
}
