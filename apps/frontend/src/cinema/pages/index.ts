// Cinema versions of the pages that sit over the dimmed galaxy (stage
// `backdrop`). main.tsx merges this over the legacy page slots when the
// cinema UI is on; a key left out keeps the legacy page as it is.
//
// Rules for entries:
// - Wrap or recompose the legacy feature component; keep its data hooks,
//   API calls and business rules (see ../README.md, "재사용하는 것과 바꾸는 것").
// - P1 pages whose API is live in production (following, followingFeed,
//   withdrawal; features/p1 `useLiveP1`) in every build; the rest
//   (notifications, statistics) only when `p1Enabled`, like main-cinema.tsx.
// - Styles in this folder, on --pc-* tokens (../styles/tokens.css). No
//   backdrop-filter over the canvas.
// - `sky`, `analysis` and `publicSky` are not pages here: the shell and
//   shell/public-galaxy own them.
import type { ComponentType } from "react";
import type { PageKey } from "../../app/paths";
import { StarResultPage } from "../../features/analysis/StarResultPage";
import {
  CommunityPage,
  PostPage,
  SignalThreadPage,
} from "../../features/community/CommunityPages";
import { HotTopicsPage } from "../../features/community/HotTopicsPage";
import { PostEditorPage } from "../../features/community/PostEditorPage";
import { FollowingFeedPage, FollowingPage } from "../../features/follow/Follow";
import { NotificationsPage } from "../../features/notifications/Notifications";
import { p1Enabled } from "../../features/p1";
import {
  MemberProfilePage,
  MyProfilePage,
} from "../../features/profile/ProfilePage";
import { SettingsPage } from "../../features/profile/SettingsPage";
import { WithdrawalPage } from "../../features/profile/WithdrawalPage";
import { PublicationPage } from "../../features/publication/PublicationPage";
import {
  CinemaHistoryDetail,
  CinemaHistoryList,
  CinemaPublicAnalysis,
  CinemaStatistics,
  cinemaUnconnected,
  framed,
} from "./routes";
import "./pages.css";

export type CinemaPageKey = Exclude<PageKey, "sky" | "analysis" | "publicSky">;
export type CinemaPageSlots = Partial<Record<CinemaPageKey, ComponentType>>;

const community = framed("community", "wide", CommunityPage);

export const cinemaPages: CinemaPageSlots = {
  // my page and other explorers
  profile: framed("profile", "wide", MyProfilePage),
  member: framed("profile", "wide", MemberProfilePage),
  settings: framed("settings", "standard", SettingsPage),
  historyList: CinemaHistoryList,
  historyDetail: CinemaHistoryDetail,
  // community
  community,
  officialThreads: community,
  starBoard: community,
  hotTopics: framed("hot-topics", "wide", HotTopicsPage),
  post: framed("post", "wide", PostPage),
  thread: framed("thread", "wide", SignalThreadPage),
  postCreate: framed("post-editor", "reading", PostEditorPage),
  postEdit: framed("post-editor", "reading", PostEditorPage),
  publicAnalysis: CinemaPublicAnalysis,
  // analysis results and publication
  starResults: framed("star-results", "standard", StarResultPage),
  publication: framed("publication", "standard", PublicationPage),
  publicationBatch: framed("publication", "standard", PublicationPage),
  // not built yet: the notice, in the product frame
  postAttachment: cinemaUnconnected("postAttachment"),
  commentAttachment: cinemaUnconnected("commentAttachment"),
  submissionResult: cinemaUnconnected("submissionResult"),
  // Live in production (features/p1.ts): in every build.
  following: framed("following", "standard", FollowingPage),
  followingFeed: framed("following-feed", "standard", FollowingFeedPage),
  withdrawal: framed("withdrawal", "standard", WithdrawalPage),
  ...(p1Enabled
    ? {
        notifications: framed("notifications", "reading", NotificationsPage),
        statistics: CinemaStatistics,
      }
    : {}),
};
