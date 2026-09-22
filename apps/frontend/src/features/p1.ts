// Enable after the frontend-led HTTP contracts are deployed. This flag never
// changes authorization: every endpoint must still enforce the server policy.
export const p1Enabled = import.meta.env.VITE_P1_ENABLED === "true";
