import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const VisualLab = import.meta.env.DEV && window.location.hash === "#visual-lab"
  ? React.lazy(() => import("./visual-lab/VisualLab"))
  : null;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {VisualLab ? <React.Suspense fallback={<p role="status">Загрузка лаборатории…</p>}><VisualLab /></React.Suspense> : <App />}
  </React.StrictMode>
);
