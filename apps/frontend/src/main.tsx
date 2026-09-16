import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App, type PageSlots } from "./app/App";
import { SessionProvider } from "./auth/SessionProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AnalysisPage } from "./features/analysis/AnalysisPage";
import "./styles.css";

// Register feature components here after their individual tickets are implemented.
async function start() {
  let pages: PageSlots = {};
  if (import.meta.env.DEV && import.meta.env.VITE_FIXTURE === "true") {
    pages = (await import("../dev/FixturePages")).fixturePages;
  }
  // Use the analysis page in both fixture and real-server modes.
  pages = { ...pages, analysis: AnalysisPage };
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <BrowserRouter>
          <SessionProvider>
            <App pages={pages} />
          </SessionProvider>
        </BrowserRouter>
      </ErrorBoundary>
    </StrictMode>,
  );
}
void start();
