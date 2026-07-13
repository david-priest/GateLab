import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// No StrictMode: its dev-only double-mount orphans the imperative D3 canvas that
// cytof_plot.js manages, causing a brief render → blank flash.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
