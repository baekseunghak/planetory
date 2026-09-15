import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App, type PageSlots } from "./app/App";
import { SessionProvider } from "./auth/SessionProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";
import { SkyDataPage } from "./features/sky-data/SkyDataPage";

// Register feature components here after their individual tickets are implemented.
async function start() {
  if (
    import.meta.env.DEV &&
    import.meta.env.VITE_GALAXY_FIXTURE === "true" &&
    window.location.pathname === "/dev/galaxy-comparison"
  ) {
    const { GalaxyComparisonPage } =
      await import("../dev/GalaxyComparisonPage");
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <ErrorBoundary>
          <GalaxyComparisonPage />
        </ErrorBoundary>
      </StrictMode>,
    );
    return;
  }
  let pages: PageSlots = { sky: SkyDataPage };
  if (import.meta.env.VITE_SKY_RENDERER_ENABLED === "true")
    pages.sky = (
      await import("./features/sky-renderer/GalaxyScene")
    ).GalaxyPage;
  if (import.meta.env.DEV && import.meta.env.VITE_FIXTURE === "true") {
    pages = (await import("../dev/FixturePages")).fixturePages;
  }
  if (import.meta.env.DEV && import.meta.env.VITE_SKY_DATA_FIXTURE === "true")
    pages.sky = (await import("../dev/SkyDataInspector")).SkyDataInspector;
  if (import.meta.env.DEV && import.meta.env.VITE_GALAXY_FIXTURE === "true")
    pages.sky = (await import("../dev/GalaxyInspector")).GalaxyInspector;
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
