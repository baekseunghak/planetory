import React from "react";

export function PhaseToolbar({ view, reset, disabled }) {
  return (
    <div className="fold-toolbar">
      <span className="mini-legend">
        <i /> 관측점 <i className="median-dot" /> 중앙값
      </span>
      <div className="chart-actions">
        <output className="zoom-readout" aria-label="가로 확대 배율">
          {view.zoom.toFixed(1)}× <span>/ 20×</span>
        </output>
        <button
          className="chart-reset"
          disabled={disabled}
          aria-label="접힌 곡선 전체 보기"
          onClick={reset}
          title="전체 보기 · 더블클릭 / 0"
        >
          ↺
        </button>
      </div>
    </div>
  );
}

export function PeriodControls({
  prefix,
  data,
  period,
  inputPeriod,
  setInputPeriod,
  periodError,
  setPeriodError,
  fineRange,
  updatePeriod,
  selected,
  range,
  validPeriod,
  confirm,
}) {
  const step = fineRange?.step || 0.0001;
  return (
    <div className="analysis-controls">
      <div className="period-control">
        <label htmlFor={`${prefix}-period-input`}>
          반복 주기 <span>PERIOD</span>
        </label>
        <div className="period-value">
          <button
            aria-label="주기 한 단계 줄이기"
            disabled={!fineRange || period - step < fineRange.min - 1e-10}
            onClick={() => updatePeriod(Math.max(fineRange.min, period - step))}
          >
            −
          </button>
          <input
            id={`${prefix}-period-input`}
            aria-invalid={!!periodError}
            aria-describedby={
              periodError ? `${prefix}-period-error` : undefined
            }
            type="number"
            step={step}
            min={fineRange?.min}
            max={fineRange?.max}
            value={inputPeriod}
            disabled={!data}
            onChange={(event) => setInputPeriod(event.target.value)}
            onBlur={() => {
              const n = Number(inputPeriod);
              if (!inputPeriod || !Number.isFinite(n) || !(n > 0)) {
                setPeriodError("0보다 큰 주기를 입력해 주세요.");
                return;
              }
              updatePeriod(n);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span>일</span>
          <button
            aria-label="주기 한 단계 늘리기"
            disabled={!fineRange || period + step > fineRange.max + 1e-10}
            onClick={() => updatePeriod(Math.min(fineRange.max, period + step))}
          >
            +
          </button>
        </div>
        <button
          className="chart-reset"
          aria-label="선택한 봉우리 주기로 초기화"
          disabled={!fineRange}
          onClick={() => updatePeriod(fineRange.origin)}
          title="선택한 봉우리 주기로 초기화"
        >
          ↺
        </button>
      </div>
      {periodError && (
        <p id={`${prefix}-period-error`} className="input-error" role="alert">
          {periodError}
        </p>
      )}
      <div className="fine-period-control">
        <div className="fine-period-label">
          <label htmlFor={`${prefix}-fine-period`}>주기 미세 조정</label>
          <span>슬라이더를 움직여 신호를 겹쳐보세요.</span>
        </div>
        <input
          id={`${prefix}-fine-period`}
          className="fine-period-slider"
          aria-label="주기 미세 조정"
          aria-valuetext={`${period.toFixed(6)}일`}
          type="range"
          min={fineRange?.min ?? 0}
          max={fineRange?.max ?? 1}
          step={step}
          value={period}
          disabled={!fineRange}
          onChange={(event) => updatePeriod(Number(event.target.value))}
        />
        <div className="fine-period-scale">
          <span>{fineRange?.min.toFixed(6) ?? "—"}일</span>
          <span>{fineRange?.max.toFixed(6) ?? "—"}일</span>
        </div>
      </div>
      <div className="selection-summary">
        <div>
          <span className="selection-summary-title">
            <i className="range-swatch" /> 가려짐 구간
          </span>
          <span className="selection-summary-value">
            {selected
              ? `${range[0].toFixed(3)} — ${range[1].toFixed(3)}`
              : "드래그로 선택 · 경계 조절"}
          </span>
        </div>
        {selected ? (
          <span className="selection-confirm confirmed">
            드래그로 다시 선택
          </span>
        ) : (
          <button
            className="selection-confirm"
            disabled={!validPeriod}
            onClick={confirm}
          >
            표시 구간 선택 <span aria-hidden="true">↗</span>
          </button>
        )}
      </div>
    </div>
  );
}
