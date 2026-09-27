import { useCinemaWording } from "../shared/cinema-wording";

// Enable after the frontend-led HTTP contracts are deployed. This flag never
// changes authorization: every endpoint must still enforce the server policy.
export const p1Enabled = import.meta.env.VITE_P1_ENABLED === "true";

/**
 * P1 features whose production API answered in a read-only check
 * (2026-09-27): another member's galaxy, follow (buttons, summaries, lists,
 * the following feed) and personal statistics. Withdrawal joined them the
 * same day (S15P21C206-180); the server switch `planetory.withdrawal.enabled`
 * still decides whether the policy reads `available`. The cinema app shows
 * them in every build. Notifications (the list answered 503) and global
 * statistics (not aggregated yet) stay behind `p1Enabled`.
 *
 * Shared screens ask this hook: only the cinema app (CinemaWording) turns it
 * on, so develop's pages (src/legacy) keep `p1Enabled` for all of them.
 */
export function useLiveP1(): boolean {
  return useCinemaWording() || p1Enabled;
}
