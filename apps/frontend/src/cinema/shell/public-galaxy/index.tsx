// /members/:memberId/sky: another member's galaxy in the one scene.
// Loaded lazily by main-cinema.tsx when P1 is on (the publicSky page slot).
//
// Contract (stage `public`, see ../stage.ts):
// - PUBLIC_GALAXY_READY makes the route stage `public`: the director leaves
//   my star and puts the scene in `galaxy` mode; SkyProvider stops feeding
//   my stars. This view then owns scene.setStars / setSystem / focusStar /
//   returnToGalaxy / showOverview and scene.onStarClick for as long as it is
//   mounted. Leaving the route feeds my stars back (SkyProvider), the
//   director flies as usual and this view frames my galaxy again.
// - The star panel reports its width with useShell().reportPanel("right",
//   px); the shell turns it into the scene inset.
// - Data: GET /v1/members/:id/sky, /sky/tiles, /stars/:tic, read with
//   features/public-sky/contracts (readPublicMeta, publicTiles,
//   readPublicSystem). Explorer list: GET /v1/me/following/members and
//   /v1/me/followers (features/follow/contracts).
// - Read only: no analysis action, the owner's name on screen at all times,
//   and a way back to my galaxy.
export { PublicGalaxyView as CinemaPublicGalaxy } from "./PublicGalaxyView";

/** The public view draws in the scene (stage `public`). */
export const PUBLIC_GALAXY_READY = true;
