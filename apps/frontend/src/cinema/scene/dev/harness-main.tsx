// Entry of harness.html. DEV server only; production builds never reference it.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../styles/tokens.css";
import "../../styles/fonts";
import "./harness.css";
import { SceneHarness } from "./SceneHarness";

if (!import.meta.env.DEV) throw new Error("scene harness is development only");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SceneHarness />
  </StrictMode>,
);
