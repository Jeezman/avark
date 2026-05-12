import React from "react";
import ReactDOM from "react-dom/client";
// Install the fetch proxy before any SDK code runs. See the module for why.
import "./lib/tauriFetch";
import App from "./App";

// Track the largest observed viewport height for bottom sheet sizing.
// Keyboard open shrinks innerHeight — we ignore those. Rotation or
// window resize that increases height is captured.
let maxHeight = window.innerHeight;
document.documentElement.style.setProperty("--app-height", `${maxHeight}px`);
window.addEventListener("resize", () => {
  if (window.innerHeight > maxHeight) {
    maxHeight = window.innerHeight;
    document.documentElement.style.setProperty("--app-height", `${maxHeight}px`);
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
