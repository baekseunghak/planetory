import { useEffect, useRef, useState } from "react";
export const guideSteps = [
  [
    "01-star-select",
    "별 선택",
    "별지도에서 살펴볼 별을 선택하고 분석 시작을 누릅니다. 열려 있는 별의 분석을 시작할 수 있습니다.",
  ],
  [
    "02-bls-peak",
    "봉우리 선택",
    "주기도에서 반복 신호가 의심되는 봉우리를 선택합니다. 선택한 주기로 접힌 밝기 변화를 살펴보세요.",
  ],
  [
    "03-transit-interval",
    "구간 선택",
    "접힌 곡선에서 밝기가 줄어든 구간의 위치와 폭을 조절합니다. 선택 구간이 신호와 맞는지 확인하세요.",
  ],
  [
    "04-judgment",
    "판단과 근거",
    "행성 같음·아닌 것 같음·모르겠음 중 판단을 고르고 관측 근거와 메모를 남깁니다.",
  ],
  [
    "05-submission",
    "검토 후 제출",
    "선택 내용을 확인하고 제출합니다. 제출 결과에 따라 계속 분석하거나 다음 별로 이동합니다. 모든 제출이 탐색 완료나 새로운 성과를 뜻하지는 않습니다.",
  ],
] as const;
export function UsageGuide() {
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false),
    [step, setStep] = useState(0),
    [failed, setFailed] = useState(false),
    [reduced, setReduced] = useState(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
    [paused, setPaused] = useState(false);
  useEffect(() => {
    const m = matchMedia("(prefers-reduced-motion: reduce)"),
      change = () => setReduced(m.matches);
    m.addEventListener("change", change);
    return () => m.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else {
      dialog.current?.close();
    }
  }, [open]);
  const close = () => {
    setOpen(false);
    dialog.current?.close();
    trigger.current?.focus();
  };
  const move = (next: number) => {
    setStep(Math.max(0, Math.min(4, next)));
    setFailed(false);
  };
  const info = guideSteps[step],
    still = reduced || paused;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => {
          move(0);
          setPaused(false);
          setOpen(true);
        }}
      >
        사용법 다시 보기
      </button>
      <dialog
        ref={dialog}
        className="usage-guide"
        aria-labelledby="usage-guide-title"
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            move(step + 1);
          }
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            move(step - 1);
          }
        }}
      >
        {open && (
          <>
            <header>
              <p className="eyebrow">
                EXPLORER GUIDE · <span aria-live="polite">{step + 1} / 5</span>
              </p>
              <button
                type="button"
                onClick={close}
                aria-label="사용법 안내 닫기"
              >
                닫기
              </button>
            </header>
            <h2 id="usage-guide-title">{info[1]}</h2>
            <p>{info[2]}</p>
            <p className="guide-caption">
              조작을 설명하는 예시입니다. 이 안내를 읽어도 탐사 상태는 바뀌지
              않습니다.
            </p>
            {!failed ? (
              <img
                key={info[0] + still}
                src={`/guides/${info[0]}.${still ? "png" : "gif"}`}
                alt={`${info[1]} 조작 예시`}
                width={960}
                height={540}
                onError={() => setFailed(true)}
              />
            ) : (
              <p className="guide-image-error" role="status">
                이미지를 불러오지 못했습니다. 위 설명과 단계 이동은 계속 이용할
                수 있습니다.
              </p>
            )}
            {!reduced && (
              <button
                type="button"
                aria-pressed={paused}
                onClick={() => {
                  setPaused(!paused);
                  setFailed(false);
                }}
              >
                {paused ? "움직임 재생" : "움직임 멈춤"}
              </button>
            )}
            <footer>
              <button
                type="button"
                disabled={step === 0}
                onClick={() => move(step - 1)}
              >
                이전
              </button>
              {step < 4 ? (
                <button type="button" onClick={() => move(step + 1)}>
                  다음
                </button>
              ) : (
                <button type="button" onClick={close}>
                  안내 마치고 닫기
                </button>
              )}
            </footer>
          </>
        )}
      </dialog>
    </>
  );
}
