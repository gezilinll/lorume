import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { resolveLorumeAppMode } from "./app-mode";
import "./ui/tokens.css";
import "./styles.css";

const runtimeMode = resolveLorumeAppMode(
  import.meta.env.VITE_LORUME_APP_MODE ?? import.meta.env.VITE_LORUME_AUTH_MODE,
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App runtimeMode={runtimeMode} />
  </React.StrictMode>,
);
