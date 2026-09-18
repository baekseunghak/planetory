// 분석 화면(은하 스타일) 팔레트의 WCAG 대비를 검산한다. docs/design.md의 '대비' 절 근거.
//
// 패널의 글래스모피즘(rgba(57,57,70,0.2) + blur)은 Figma 원본을 그대로 쓴다.
// 은하 배경은 이미지라 픽셀마다 밝기가 다르므로 가장 밝은 영역을 최악값으로 잡고
// 배경 → 오버레이 → 패널 → (플롯) → 글자 순서로 실제 합성 결과를 계산한다.
//
// 실행: node scripts/check-contrast.mjs

const toLinear = (channel) => {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]) =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

const contrast = (fg, bg) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};

// alpha로 fg를 bg 위에 올렸을 때의 실효 색
const composite = (fg, bg, alpha) =>
  fg.map((channel, i) => Math.round(channel * alpha + bg[i] * (1 - alpha)));

const BG = [34, 40, 49]; // --bg #222831
const FG = [238, 238, 238]; // --fg #eeeeee
const ACCENT = [255, 211, 105]; // --accent #ffd369
const GLASS = [57, 57, 70]; // 패널 유리색 — Figma 원본

const OVERLAY = 0.75; // Figma 0.4에서 올림. 유리는 그대로 두고 뒤쪽만 어둡게 한다
const PANEL = 0.2; // Figma 원본 그대로
const PLOT = 0.4; // 패널 안 그래프 영역, Figma 원본 그대로

// 은하 배경에서 가장 밝은 영역. 여기가 통과하면 나머지는 전부 통과한다.
// src/features/analysis/assets/galaxy-background.webp를 실측한 값이다(1505x1045).
// 평균 rgb(10,13,21) · 상위 1% rgb(102,104,125) · 상위 0.1% rgb(170,168,185).
// 개별 별 픽셀은 순백까지 가지만 blur(11px)가 유리 뒤에서 이를 주변과 평균내므로
// 유리 위 글자는 '영역' 밝기로 판단한다. 블러가 없는 패널 밖은 아래에서 따로 본다.
const BRIGHTEST = [170, 168, 185];
const STAR = [255, 255, 255]; // 블러가 없는 표면의 최악 픽셀

const surfaces = (star, overlay) => {
  const overlaid = composite(BG, star, overlay);
  const panel = composite(GLASS, overlaid, PANEL);
  return { overlaid, panel, plot: composite(BG, panel, PLOT) };
};

// [이름, 알파(null=불투명 #eee, "accent"=금색), 글자 크기(px). 0이면 비텍스트 3:1]
// 격자는 플롯 영역 안에만 그려지므로 패널 표면에서는 검사하지 않는다.
const TEXT_LEVELS = [
  ["--fg-1 제목·본문", null, 16],
  ["--fg-2 수치 강조", 0.8, 14],
  ["--fg-3 라벨·축·설명", 0.67, 11],
  ["--accent 강조", "accent", 13],
];
const GRID_LEVEL = ["--grid 격자", 0.42, 0];

let failed = 0;

const check = (surfaceName, bg, levels) => {
  console.log(`\n[${surfaceName}] rgb(${bg.join(", ")})`);
  for (const [name, alpha, px] of levels) {
    const color =
      alpha === null
        ? FG
        : alpha === "accent"
          ? ACCENT
          : composite(FG, bg, alpha);
    const ratio = contrast(color, bg);
    const required = px === 0 ? 3 : px >= 18 ? 3 : 4.5;
    const ok = ratio >= required;
    if (!ok) failed += 1;
    console.log(
      `  ${ok ? "통과" : "미달"}  ${name.padEnd(22)} ${(px === 0 ? "비텍스트" : `${px}px`).padEnd(8)} ${ratio.toFixed(2)}:1 (${required}:1 필요)`,
    );
  }
};

console.log(
  `패널 rgba(57,57,70,${PANEL}) + blur(11px) 유지 · 오버레이 ${OVERLAY} · 은하 배경 가장 밝은 영역 기준`,
);
const worst = surfaces(BRIGHTEST, OVERLAY);
check("헤더·패널 배경", worst.panel, TEXT_LEVELS);
check("그래프 플롯 영역", worst.plot, [...TEXT_LEVELS, GRID_LEVEL]);
// 단계 표시·보조 링크·헤더는 유리 위가 아니라 오버레이한 배경 위에 바로 놓인다.
check("패널 밖 배경 (블러 없음)", worst.overlaid, TEXT_LEVELS);

// 블러가 없는 표면에서는 별 픽셀이 평균되지 않는다. 남은 위험으로 기록한다.
console.log("\n참고 · 패널 밖에서 순백 별 픽셀이 글자 뒤에 올 때");
{
  const bare = surfaces(STAR, OVERLAY).overlaid;
  console.log(`  배경 rgb(${bare.join(", ")})`);
  for (const [name, alpha, px] of TEXT_LEVELS) {
    const color =
      alpha === null ? FG : alpha === "accent" ? ACCENT : composite(FG, bare, alpha);
    const ratio = contrast(color, bare);
    console.log(
      `    ${name.padEnd(22)} ${`${px}px`.padEnd(6)} ${ratio.toFixed(2)}:1${ratio >= 4.5 ? "" : "  ← 4.5:1 미달"}`,
    );
  }
  console.log(
    "  오버레이를 0.85로 올리면 이 경우도 전부 통과한다 (--fg-3 4.59:1). 채택 여부는 미정.",
  );
}

// 배경 이미지를 교체할 때 이 밝기를 넘으면 오버레이를 더 올려야 한다.
console.log("\n배경 이미지 교체 시 허용 최대 밝기");
{
  let limit = null;
  for (let v = 10; v <= 255; v += 1) {
    const { panel } = surfaces([v, v + 5, v + 20], OVERLAY);
    if (contrast(composite(FG, panel, 0.67), panel) < 4.5) {
      limit = v - 1;
      break;
    }
  }
  console.log(
    limit === null
      ? `  오버레이 ${OVERLAY}에서는 어떤 밝기도 통과`
      : `  가장 밝은 픽셀이 약 rgb(${limit}, ${limit + 5}, ${limit + 20}) 이하`,
  );
}

// Figma 원본 값이 왜 미달인지 남겨둔다. 실패로 세지 않는다.
console.log("\n참고 · Figma 원본 값 (채택하지 않음)");
{
  const { panel, plot } = surfaces(BRIGHTEST, 0.4);
  console.log(`  오버레이 0.4 → 패널 rgb(${panel.join(", ")})`);
  for (const alpha of [0.67, 0.4, 0.33]) {
    console.log(
      `    글자 알파 ${alpha} → ${contrast(composite(FG, panel, alpha), panel).toFixed(2)}:1`,
    );
  }
  console.log(
    `    격자 #393e46 → ${contrast([57, 62, 70], plot).toFixed(2)}:1`,
  );
}

if (failed > 0) {
  console.error(`\n채택 팔레트에서 ${failed}개 미달.`);
  process.exit(1);
}
console.log("\n채택 팔레트 전부 통과.");
