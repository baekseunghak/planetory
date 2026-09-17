/** Keep a dense overview gentle, then restore individual starlight as we approach. */
export function galaxyExposure(starCount: number, zoom: number): number {
  const overview = Math.min(
    1,
    Math.pow(1000 / Math.max(1000, starCount), 0.36),
  );
  // Logarithmic zoom matches the multiplicative wheel/buttons. Smoothstep avoids
  // a brightness jump at 100% and stops increasing at 600% (original exposure).
  const t = Math.max(0, Math.min(1, Math.log(Math.max(1, zoom)) / Math.log(6)));
  const approach = t * t * (3 - 2 * t);
  return overview + (1 - overview) * approach;
}
