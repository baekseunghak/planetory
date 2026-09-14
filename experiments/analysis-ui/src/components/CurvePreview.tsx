import raw from '../../../../docs/api/analysis/examples/01-session-and-curve.json';

// These nine samples are the synthetic contract fixture, never a generated TESS observation.
const data = raw.exchanges[1].response.body;
const times = data.time_btjd ?? [];
const flux = data.normalized_flux ?? [];
const valid = data.quality_valid ?? [];

export function CurvePreview() {
  const x = (t: number) => 56 + ((t - 1000) / 12) * 640;
  const y = (f: number) => 30 + ((1.004 - f) / 0.019) * 144;
  return (
    <figure className="curve-figure">
      <div className="section-label">
        <span>제출 당시 광도곡선</span>
        <span className="subtle">샘플 9점 · 읽기 전용</span>
      </div>
      <svg
        viewBox="0 0 740 220"
        role="img"
        aria-label="합성 관측 9점의 광도곡선. 밝기가 주기적으로 감소하며 품질 제외 점은 빈 원으로 표시됩니다."
      >
        {[1, 0.995, 0.99].map((f) => (
          <g key={f}>
            <line x1="56" x2="696" y1={y(f)} y2={y(f)} className="chart-grid" />
            <text x="40" y={y(f) + 4} textAnchor="end">
              {f.toFixed(3)}
            </text>
          </g>
        ))}
        {[1000, 1003, 1006, 1009, 1012].map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1="26" y2="176" className="chart-grid vertical" />
            <text x={x(t)} y="198" textAnchor="middle">
              {t}
            </text>
          </g>
        ))}
        <line x1="56" x2="696" y1="176" y2="176" className="chart-axis" />
        {times.map((t, i) => (
          <g key={t}>
            <circle
              cx={x(t)}
              cy={y(flux[i])}
              r="9"
              className={valid[i] ? 'point-halo' : 'masked-halo'}
            />
            <circle
              cx={x(t)}
              cy={y(flux[i])}
              r="3.6"
              className={valid[i] ? 'point' : 'masked-point'}
            />
          </g>
        ))}
        <text x="696" y="217" textAnchor="end">
          관측 시각 (BTJD)
        </text>
      </svg>
      <figcaption>
        <span>
          <i className="legend-dot" />
          유효 관측
        </span>
        <span>
          <i className="legend-dot outline" />
          품질 제외
        </span>
        <span className="subtle">원본 곡선 · 관측 12일</span>
      </figcaption>
    </figure>
  );
}
