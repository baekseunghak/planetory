// OAuth endpoints and the initial-profile signal are supplied by the auth backend.
// No production defaults: the service API explicitly leaves these contracts open.
export const authSettings = {
  ssafy: import.meta.env.VITE_OAUTH_SSAFY_URL || "",
  google: import.meta.env.VITE_OAUTH_GOOGLE_URL || "",
  nicknameRequiredCode: import.meta.env.VITE_NICKNAME_REQUIRED_CODE || "",
  initialNicknamePath: import.meta.env.VITE_INITIAL_NICKNAME_PATH || "",
};
