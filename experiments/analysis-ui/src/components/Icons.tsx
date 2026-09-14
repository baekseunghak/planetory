import type { CSSProperties } from 'react';

export function OrbitMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <circle cx="20" cy="20" r="8" fill="currentColor" />
      <ellipse
        cx="20"
        cy="20"
        rx="19"
        ry="7"
        transform="rotate(-32 20 20)"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="34" cy="8" r="2.6" fill="currentColor" />
    </svg>
  );
}

export function Icon({
  name,
  size = 18,
  style,
}: {
  name: 'chart' | 'history' | 'share' | 'arrow' | 'check' | 'retry' | 'close' | 'monitor';
  size?: number;
  style?: CSSProperties;
}) {
  const paths = {
    chart: 'M3 3v18h18M6 14l4-5 4 3 5-7',
    history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2',
    share: 'M12 16V3m-4 4 4-4 4 4M4 13v7h16v-7',
    arrow: 'M4 12h16m-6-6 6 6-6 6',
    check: 'm5 12 4 4L19 6',
    retry: 'M3 10a9 9 0 1 1 1 7M3 3v7h7',
    close: 'm5 5 14 14M19 5 5 19',
    monitor: 'M3 4h18v13H3zM8 21h8m-4-4v4',
  };
  return (
    <svg
      width={size}
      height={size}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
