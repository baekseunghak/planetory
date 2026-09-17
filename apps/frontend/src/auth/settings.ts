// 156/157: same-origin OAuth entry; the backend assigns an initial nickname.
// The optional initial-profile adapter is only enabled by an explicit contract.
export const authSettings = {
  ssafy: import.meta.env.VITE_OAUTH_SSAFY_URL ?? "/oauth2/authorization/ssafy",
  google:
    import.meta.env.VITE_OAUTH_GOOGLE_URL ?? "/oauth2/authorization/google",
  nicknameRequiredCode: import.meta.env.VITE_NICKNAME_REQUIRED_CODE || "",
  initialNicknamePath: import.meta.env.VITE_INITIAL_NICKNAME_PATH || "",
};
