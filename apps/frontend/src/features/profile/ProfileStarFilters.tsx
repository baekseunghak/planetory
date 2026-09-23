import { useEffect, useState, type ComponentType } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { StarFilterFields } from "../sky-renderer/StarSearch";
import {
  emptyStarFilters,
  filtersFromSearch,
  searchWithFilters,
} from "../sky-renderer/star-search";
import type { ProfileSlotProps } from "./ProfileSlots";

export function ProfileStarFilters({
  Page,
  ...props
}: ProfileSlotProps & { Page: ComponentType<ProfileSlotProps> }) {
  const location = useLocation(),
    navigate = useNavigate();
  let filters = emptyStarFilters,
    problem = "";
  try {
    filters = filtersFromSearch(location.search);
  } catch (e) {
    problem = (e as Error).message;
  }
  const signature = JSON.stringify(filters);
  const [draft, setDraft] = useState(filters),
    [error, setError] = useState("");
  useEffect(() => {
    setDraft(JSON.parse(signature));
    setError("");
  }, [signature, props.memberId]);
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            navigate({
              pathname: location.pathname,
              search: searchWithFilters(location.search, draft),
            });
            setError("");
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <StarFilterFields value={draft} onChange={setDraft} />
        <button type="submit">내 별 검색</button>
        <button
          type="button"
          onClick={() => {
            setDraft(emptyStarFilters);
            setError("");
            navigate({
              pathname: location.pathname,
              search: searchWithFilters(location.search, emptyStarFilters),
            });
          }}
        >
          검색 초기화
        </button>
      </form>
      {(error || problem) && <p role="alert">{error || problem}</p>}
      {!problem && <Page {...props} starFilters={filters} />}
    </>
  );
}
