import {
  createContext,
  useContext,
  useEffect,
  type ComponentType,
} from "react";
import { Link } from "react-router-dom";
import { GalaxyArtwork } from "../../components/GalaxyArtwork";
import { useSkyData } from "./useSkyData";

/**
 * Replaces the preview where the app already holds the sky: the cinema pages
 * reuse the shell's one sky store instead of reading the whole sky again.
 */
export const MySkyPreviewSlot = createContext<ComponentType | null>(null);

export function MySkyPreview() {
  const Slot = useContext(MySkyPreviewSlot);
  return Slot ? <Slot /> : <SkyPreview />;
}

/** The prototype's small galaxy, using the existing authenticated, paged sky reader. */
function SkyPreview() {
  const { data, store } = useSkyData();
  const meta = data.meta;
  useEffect(() => {
    if (meta && store) {
      const { minX, minY, maxX, maxY } = meta.bounds;
      void store.setView({
        level: meta.zoomLevels[0].level,
        box: {
          x: minX - 1,
          y: minY - 1,
          w: maxX - minX + 2,
          h: maxY - minY + 2,
        },
      });
    }
  }, [store, meta]);
  return (
    <section className="my-sky-preview" aria-label="나의 밤하늘 미리보기">
      <p className="eyebrow">YOUR NIGHT SKY</p>
      <h3>나의 밤하늘</h3>
      <GalaxyArtwork stars={data.stars} />
      <footer className="sky-preview-caption">
        {meta ? (
          <p>{meta.starCount.toLocaleString()}개의 별</p>
        ) : (
          <span>
            {data.error
              ? "미리보기 연결을 확인해 주세요"
              : "밤하늘을 불러오고 있어요"}
          </span>
        )}
        <Link to="/sky" aria-label="나의 별지도 열기">
          ↗
        </Link>
      </footer>
      {data.error || data.failures.length ? (
        <p role="status">
          미리보기를 불러오지 못했어요.{" "}
          <button onClick={() => void store?.retry()}>다시 보기</button>
        </p>
      ) : data.pending > 0 ? (
        <p role="status">
          별빛을 모으고 있어요 · {data.loadedCount.toLocaleString()}개 적재
        </p>
      ) : (
        <p>
          {meta?.starCount === 0
            ? "첫 발견으로 밤하늘을 채워보세요."
            : "발견한 별들이 모여 나만의 우주가 됩니다."}
        </p>
      )}
    </section>
  );
}
