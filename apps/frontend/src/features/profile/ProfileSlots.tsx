import { createContext, useContext, type ComponentType } from "react";
import type { StarFilters } from "../sky-renderer/star-search";
export type ProfileSlotProps = {
  memberId: string;
  isOwn: boolean;
  starListVisibility: "PUBLIC" | "PRIVATE";
  /** A13 own-star list: consume via starSearchPath(filters, cursor, "submitted"). */
  starFilters?: StarFilters;
};
export type ProfileSlotComponents = {
  stars?: ComponentType<ProfileSlotProps>;
  history?: ComponentType<ProfileSlotProps>;
  statistics?: ComponentType<ProfileSlotProps>;
};
export const ProfileSlots = createContext<ProfileSlotComponents>({});
export function ProfileSection({
  section,
  ...props
}: ProfileSlotProps & { section: keyof ProfileSlotComponents }) {
  const slots = useContext(ProfileSlots),
    Page = slots[section];
  if (!props.isOwn && section !== "stars") return null;
  if (!props.isOwn && props.starListVisibility === "PRIVATE")
    return (
      <p role="status">
        이 회원의 별 목록은 비공개입니다. 별별 진행 정보는 볼 수 없습니다.
      </p>
    );
  return Page ? (
    <Page {...props} />
  ) : (
    <p className="profile-unconnected">
      {section === "stars"
        ? "별 목록"
        : section === "history"
          ? "내 분석 기록"
          : "통계"}{" "}
      화면은 연결 준비 중입니다.
    </p>
  );
}
