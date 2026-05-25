import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { resolveLorumeAppMode } from "./app-mode";
import "./index.css";

const runtimeMode = resolveLorumeAppMode(import.meta.env.VITE_LORUME_APP_MODE);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App runtimeMode={runtimeMode} />
  </React.StrictMode>,
);
