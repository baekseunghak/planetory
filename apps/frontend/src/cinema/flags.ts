// Switches of the cinema UI.
//
// Which app a visit loads (build-time VITE_CINEMA, else the visitor's
// ?ui=cinema / ?ui=legacy choice, default legacy) is decided in
// ../ui-choice.ts before either app starts; see ../main.tsx.
export { UI_PARAM, UI_STORAGE_KEY } from "../ui-choice";
