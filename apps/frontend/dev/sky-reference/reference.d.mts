import type { Star } from "../../src/features/sky-data/contracts.ts";
export const LAYOUT_VERSION: "personal-spiral-v1";
export const PRESENTATION_VERSION: "personal-galaxy-v1";
export const DEPTH_SCALE: 256;
export const INITIAL_CAMERA: {
  x: number;
  y: number;
  zoom: number;
  yaw: number;
  tilt: number;
  roll: number;
};
export function layout(
  n: number,
): Pick<Star, "x" | "y" | "depthZ" | "layoutOrdinal">;
export function exampleStar(n: number): Star;
export function exampleAccount(n: number): Star[];
export function appearance(s: Pick<Star, "x" | "y" | "layoutOrdinal">): {
  rgb: number[];
  baseSize: number;
};
export function project(
  s: Pick<Star, "x" | "y" | "depthZ">,
  camera: typeof INITIAL_CAMERA,
  width: number,
  height: number,
): { x: number; y: number };
