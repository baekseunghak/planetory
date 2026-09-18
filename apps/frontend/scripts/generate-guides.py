#!/usr/bin/env python3
"""Generate Planetory's five read-only tutorial animations.

The script writes one looping 16:9 GIF and one matching PNG poster per step.
It has no project dependencies other than Pillow and writes beside itself by
default, so it can be run without touching the frontend source tree.
"""

from __future__ import annotations

import argparse
import math
import random
from pathlib import Path
from typing import Callable, Iterable

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError as exc:  # pragma: no cover - friendly command-line failure
    raise SystemExit("Pillow is required. Install it with: python -m pip install Pillow") from exc


WIDTH, HEIGHT = 960, 540
FRAME_COUNT = 36
FRAME_MS = 75

INK = "#F5F7FA"
MUTED = "#89929E"
FAINT = "#4B5563"
LINE = "#27313D"
PANEL = "#0B1119"
PANEL_2 = "#0F1722"
SPACE = "#030609"
CYAN = "#69D5FF"
BLUE = "#5E8CFF"
VIOLET = "#A68BFF"
AMBER = "#F4C56A"
GREEN = "#55D6A3"
RED = "#F47E86"


def clamp(value: float, low: int = 0, high: int = 255) -> int:
    return max(low, min(high, int(value)))


def rgba(hex_color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    value = hex_color.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4)) + (alpha,)


def mix(a: str, b: str, amount: float) -> tuple[int, int, int, int]:
    ca, cb = rgba(a), rgba(b)
    return tuple(clamp(ca[i] + (cb[i] - ca[i]) * amount) for i in range(3)) + (255,)


def ease(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def pulse(t: float, phase: float = 0.0) -> float:
    return 0.5 + 0.5 * math.sin((t + phase) * math.tau)


def find_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    windows = Path("C:/Windows/Fonts")
    candidates = (
        [windows / "malgunbd.ttf", windows / "segoeuib.ttf"]
        if bold
        else [windows / "malgun.ttf", windows / "segoeui.ttf"]
    )
    candidates += [
        Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


FONTS = {
    "brand": find_font(17, True),
    "eyebrow": find_font(11, True),
    "title": find_font(30, True),
    "subtitle": find_font(15),
    "body": find_font(14),
    "small": find_font(11),
    "small_bold": find_font(11, True),
    "number": find_font(17, True),
}


def text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[float, float],
    value: str,
    font: str = "body",
    fill: str | tuple[int, ...] = INK,
    anchor: str | None = None,
) -> None:
    draw.text(xy, value, font=FONTS[font], fill=fill, anchor=anchor)


def glow_dot(
    image: Image.Image,
    xy: tuple[float, float],
    radius: float,
    color: str,
    strength: float = 1.0,
) -> None:
    x, y = xy
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    for scale, alpha in ((5.0, 22), (2.8, 42), (1.7, 80)):
        rr = radius * scale
        ld.ellipse((x - rr, y - rr, x + rr, y + rr), fill=rgba(color, clamp(alpha * strength)))
    layer = layer.filter(ImageFilter.GaussianBlur(max(2, int(radius * 2.3))))
    image.alpha_composite(layer)
    d = ImageDraw.Draw(image)
    d.ellipse((x - radius, y - radius, x + radius, y + radius), fill=rgba(color, 245))
    core = max(0.8, radius * 0.35)
    d.ellipse((x - core, y - core, x + core, y + core), fill=(255, 255, 255, 255))


def panel(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], radius: int = 12) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=PANEL, outline=LINE, width=1)


def base_frame(step: int, title_value: str, subtitle: str) -> Image.Image:
    image = Image.new("RGBA", (WIDTH, HEIGHT), rgba(SPACE))
    bg = ImageDraw.Draw(image)
    for y in range(HEIGHT):
        amount = y / HEIGHT
        bg.line((0, y, WIDTH, y), fill=mix("#07111C", SPACE, amount))

    randomizer = random.Random(504 + step)
    for _ in range(95):
        x, y = randomizer.randrange(WIDTH), randomizer.randrange(HEIGHT)
        radius = randomizer.choice((1, 1, 1, 2))
        alpha = randomizer.randrange(35, 105)
        bg.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(180, 210, 240, alpha))

    bg.rectangle((0, 0, WIDTH, 55), fill="#050A10")
    bg.line((0, 55, WIDTH, 55), fill=LINE)
    text(bg, (32, 28), "PLANETORY", "brand", INK, "lm")
    text(bg, (928, 28), f"GUIDE  {step:02d} / 05", "eyebrow", MUTED, "rm")
    text(bg, (48, 84), f"STEP {step}", "eyebrow", CYAN)
    text(bg, (48, 104), title_value, "title", INK)
    text(bg, (48, 145), subtitle, "subtitle", MUTED)
    return image


def progress(draw: ImageDraw.ImageDraw, step: int) -> None:
    x, y, gap = 48, 507, 18
    labels = ("별 선택", "봉우리", "구간", "판단", "제출")
    for index, label in enumerate(labels, start=1):
        color = CYAN if index <= step else FAINT
        draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill=color)
        text(draw, (x + 10, y), label, "small", color, "lm")
        x += gap + 68
        if index < len(labels):
            draw.line((x - 13, y, x - 3, y), fill=color, width=1)


def cursor(draw: ImageDraw.ImageDraw, x: float, y: float, click: float = 0.0) -> None:
    if click > 0:
        radius = 12 + click * 13
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline=rgba(CYAN, clamp(110 * (1 - click))), width=2)
    points = [(x, y), (x + 2, y + 19), (x + 7, y + 14), (x + 13, y + 24), (x + 17, y + 22), (x + 11, y + 12), (x + 19, y + 10)]
    draw.polygon(points, fill=INK, outline="#111820")


def galaxy_points(seed: int = 19) -> list[tuple[float, float, float, str]]:
    rng = random.Random(seed)
    values: list[tuple[float, float, float, str]] = []
    for _ in range(280):
        arm = rng.randrange(3)
        radius = 15 + (rng.random() ** 0.62) * 205
        angle = arm * math.tau / 3 + radius / 58 + rng.gauss(0, 0.16 + radius / 950)
        x = 515 + math.cos(angle) * radius
        y = 334 + math.sin(angle) * radius * 0.43
        size = rng.choice((0.7, 0.8, 1.0, 1.2, 1.6))
        color = rng.choice((INK, CYAN, BLUE, AMBER, "#9FB6D8"))
        values.append((x, y, size, color))
    return values


GALAXY = galaxy_points()


def frame_star_select(index: int) -> Image.Image:
    t = index / FRAME_COUNT
    image = base_frame(1, "분석할 별을 선택합니다", "별지도의 빛 하나를 골라 탐색을 시작하세요.")
    draw = ImageDraw.Draw(image)
    panel(draw, (40, 183, 920, 479))
    draw.line((702, 184, 702, 478), fill=LINE)

    for x, y, r, color in GALAXY:
        draw.ellipse((x - r, y - r, x + r, y + r), fill=rgba(color, 190))
    for radius, alpha in ((80, 10), (45, 19), (18, 55)):
        draw.ellipse((515 - radius, 334 - radius * 0.42, 515 + radius, 334 + radius * 0.42), fill=rgba(CYAN, alpha))

    target = (584, 294)
    glow_dot(image, target, 3.0, CYAN, 0.8 + 0.2 * pulse(t))
    draw = ImageDraw.Draw(image)
    ring = 13 + 5 * pulse(t)
    draw.ellipse((target[0] - ring, target[1] - ring, target[0] + ring, target[1] + ring), outline=rgba(CYAN, 205), width=1)

    text(draw, (732, 219), "SELECTED STAR", "eyebrow", CYAN)
    text(draw, (732, 249), "TIC 259377017", "number", INK)
    text(draw, (732, 280), "TOI-270", "body", MUTED)
    draw.line((732, 307, 884, 307), fill=LINE)
    text(draw, (732, 331), "관측 섹터", "small", MUTED)
    text(draw, (884, 331), "3 · 30", "small_bold", INK, "rm")
    text(draw, (732, 358), "밝기", "small", MUTED)
    text(draw, (884, 358), "10.87 mag", "small_bold", INK, "rm")
    draw.rounded_rectangle((732, 397, 884, 435), radius=19, fill=CYAN)
    text(draw, (808, 416), "분석 시작", "small_bold", "#041018", "mm")

    move = ease(min(1.0, t * 2.2))
    cx = 758 + (target[0] - 758) * move
    cy = 413 + (target[1] - 413) * move
    click_phase = max(0.0, min(1.0, (t - 0.48) * 7))
    cursor(draw, cx, cy, click_phase)
    progress(draw, 1)
    return image


def periodogram_points(phase: float) -> list[tuple[float, float]]:
    values: list[tuple[float, float]] = []
    for i in range(270):
        x = 85 + i * 2.15
        base = 390 - 13 * math.sin(i * 0.24) - 8 * math.sin(i * 0.77)
        peak = 142 * math.exp(-((i - 177) / 7.2) ** 2)
        secondary = 43 * math.exp(-((i - 93) / 12) ** 2)
        shimmer = 3 * math.sin(i * 0.4 + phase * math.tau)
        values.append((x, base - peak - secondary + shimmer))
    return values


def frame_bls_peak(index: int) -> Image.Image:
    t = index / FRAME_COUNT
    image = base_frame(2, "BLS 피크를 찾습니다", "가장 높게 솟은 신호가 반복 주기의 후보입니다.")
    draw = ImageDraw.Draw(image)
    panel(draw, (40, 183, 690, 479))
    panel(draw, (710, 183, 920, 479))
    left, top, right, bottom = 84, 221, 650, 430
    for y in (250, 300, 350, 400):
        draw.line((left, y, right, y), fill="#18222D")
    for x in (135, 245, 355, 465, 575):
        draw.line((x, top, x, bottom), fill="#111A24")
    draw.line((left, bottom, right, bottom), fill=FAINT)
    draw.line((left, top, left, bottom), fill=FAINT)
    points = periodogram_points(t)
    reveal = max(4, int(len(points) * min(1, t * 2.0)))
    draw.line(points[:reveal], fill=CYAN, width=2, joint="curve")

    peak_x = points[177][0]
    peak_y = points[177][1]
    if reveal > 177:
        draw.line((peak_x, top, peak_x, bottom), fill=rgba(VIOLET, 150), width=1)
        glow_dot(image, (peak_x, peak_y), 3.5, VIOLET, 0.8 + 0.2 * pulse(t))
        draw = ImageDraw.Draw(image)
        label_y = max(top + 6, peak_y - 42)
        draw.rounded_rectangle((peak_x - 46, label_y, peak_x + 46, label_y + 27), radius=13, fill="#1B1930", outline=VIOLET)
        text(draw, (peak_x, label_y + 14), "5.66051 d", "small_bold", INK, "mm")

    text(draw, (84, 205), "BLS PERIODOGRAM", "eyebrow", MUTED)
    text(draw, (367, 458), "주기 (days)", "small", MUTED, "mm")
    text(draw, (741, 219), "CANDIDATE", "eyebrow", VIOLET)
    text(draw, (741, 253), "5.66051", "title", INK)
    text(draw, (875, 272), "days", "small", MUTED, "rm")
    draw.line((741, 298, 889, 298), fill=LINE)
    text(draw, (741, 325), "SDE", "small", MUTED)
    text(draw, (889, 325), "12.84", "small_bold", INK, "rm")
    text(draw, (741, 353), "DEPTH", "small", MUTED)
    text(draw, (889, 353), "2,140 ppm", "small_bold", INK, "rm")
    draw.rounded_rectangle((741, 397, 889, 435), radius=19, outline=CYAN, width=1)
    text(draw, (815, 416), "피크 선택", "small_bold", CYAN, "mm")
    cursor(draw, peak_x + 15, peak_y + 30, max(0.0, min(1.0, (t - 0.62) * 8)))
    progress(draw, 2)
    return image


def light_curve(x: float, period: float = 128.0) -> float:
    phase = ((x - 85) % period) / period
    dip = 33 * math.exp(-((phase - 0.51) / 0.052) ** 2)
    noise = 2.0 * math.sin(x * 0.28) + 1.2 * math.sin(x * 0.79)
    return 321 + dip + noise


def frame_transit_interval(index: int) -> Image.Image:
    t = index / FRAME_COUNT
    image = base_frame(3, "감광 구간을 맞춥니다", "반복해서 어두워지는 구간을 이동하고 폭을 조절하세요.")
    draw = ImageDraw.Draw(image)
    panel(draw, (40, 183, 920, 479))
    left, right, top, bottom = 79, 881, 224, 414
    draw.line((left, 321, right, 321), fill="#23303D")
    for y in (250, 285, 357, 392):
        draw.line((left, y, right, y), fill="#121C26")

    offset = (1 - ease(min(1, t * 1.8))) * 24
    windows = [214 + offset, 470 + offset, 726 + offset]
    for center in windows:
        width = 47 + 4 * math.sin(t * math.tau)
        draw.rounded_rectangle((center - width / 2, top, center + width / 2, bottom), radius=6, fill=rgba(BLUE, 28), outline=rgba(BLUE, 135), width=1)
        draw.line((center - width / 2, 290, center - width / 2, 371), fill=BLUE, width=2)
        draw.line((center + width / 2, 290, center + width / 2, 371), fill=BLUE, width=2)
        for handle_x in (center - width / 2, center + width / 2):
            draw.rounded_rectangle((handle_x - 4, 325, handle_x + 4, 344), radius=3, fill=BLUE)

    curve = [(x, light_curve(x)) for x in range(left, right + 1, 2)]
    draw.line(curve, fill="#9FB6D8", width=2)
    for x, y in curve[::6]:
        draw.ellipse((x - 1.5, y - 1.5, x + 1.5, y + 1.5), fill=INK)

    text(draw, (79, 204), "PHASE-FOLDED LIGHT CURVE", "eyebrow", MUTED)
    draw.rounded_rectangle((73, 432, 887, 459), radius=13, fill="#07101A", outline=LINE)
    thumb_x = 110 + ease(min(1, t * 1.45)) * 336
    draw.line((99, 446, 861, 446), fill=FAINT, width=2)
    draw.line((99, 446, thumb_x, 446), fill=CYAN, width=2)
    draw.ellipse((thumb_x - 7, 439, thumb_x + 7, 453), fill=INK, outline=CYAN)
    text(draw, (99, 446), "−", "small_bold", MUTED, "mm")
    text(draw, (861, 446), "+", "small_bold", MUTED, "mm")
    cursor(draw, windows[1] + 18, 337, max(0.0, min(1.0, (t - 0.64) * 7)))
    progress(draw, 3)
    return image


def frame_judgment(index: int) -> Image.Image:
    t = index / FRAME_COUNT
    image = base_frame(4, "신호를 판단합니다", "그래프를 근거로 가장 알맞은 판단 하나를 고르세요.")
    draw = ImageDraw.Draw(image)
    panel(draw, (40, 183, 604, 479))
    panel(draw, (624, 183, 920, 479))
    text(draw, (74, 213), "SIGNAL SUMMARY", "eyebrow", MUTED)
    text(draw, (74, 247), "TIC 259377017 · Candidate 02", "number", INK)
    draw.line((74, 280, 570, 280), fill=LINE)
    metrics = (("주기", "5.66051 days"), ("감광 깊이", "2,140 ppm"), ("반복 횟수", "16 transits"), ("SDE", "12.84"))
    for row, (label, value) in enumerate(metrics):
        y = 313 + row * 35
        text(draw, (74, y), label, "small", MUTED)
        text(draw, (570, y), value, "small_bold", INK, "rm")

    text(draw, (654, 213), "YOUR JUDGMENT", "eyebrow", CYAN)
    options = (
        ("행성 가능성 높음", "LIKELY PLANET", GREEN),
        ("판단 보류", "UNSURE", AMBER),
        ("행성 가능성 낮음", "UNLIKELY", RED),
    )
    selected = t > 0.42
    for option_index, (ko, en, color) in enumerate(options):
        y = 249 + option_index * 67
        is_selected = selected and option_index == 0
        fill = rgba(color, 28) if is_selected else rgba(PANEL_2)
        outline = color if is_selected else LINE
        draw.rounded_rectangle((654, y, 890, y + 51), radius=10, fill=fill, outline=outline, width=2 if is_selected else 1)
        draw.ellipse((671, y + 17, 687, y + 33), outline=color if is_selected else FAINT, width=2)
        if is_selected:
            draw.ellipse((675, y + 21, 683, y + 29), fill=color)
        text(draw, (699, y + 13), ko, "small_bold", INK)
        text(draw, (699, y + 34), en, "small", color if is_selected else MUTED)

    move = ease(min(1.0, t * 2.0))
    cx = 825 + (679 - 825) * move
    cy = 430 + (275 - 430) * move
    cursor(draw, cx, cy, max(0.0, min(1.0, (t - 0.45) * 8)))
    progress(draw, 4)
    return image


def frame_submission(index: int) -> Image.Image:
    t = index / FRAME_COUNT
    image = base_frame(5, "검토하고 제출합니다", "선택 내용을 확인하고 제출합니다. 결과에 따라 탐사를 이어갑니다.")
    draw = ImageDraw.Draw(image)
    panel(draw, (106, 183, 854, 479))
    text(draw, (144, 216), "FINAL REVIEW", "eyebrow", MUTED)
    text(draw, (144, 250), "TIC 259377017", "number", INK)
    text(draw, (816, 250), "TOI-270", "body", MUTED, "rm")
    draw.line((144, 278, 816, 278), fill=LINE)
    rows = (
        ("선택한 BLS 피크", "5.66051 days"),
        ("감광 깊이", "2,140 ppm"),
        ("최종 판단", "행성 가능성 높음"),
    )
    for row_index, (label, value) in enumerate(rows):
        y = 310 + row_index * 38
        visible = t > row_index * 0.08
        color = GREEN if visible else FAINT
        draw.ellipse((146, y - 7, 160, y + 7), outline=color, width=1)
        if visible:
            draw.line((149, y, 153, y + 4, 158, y - 4), fill=color, width=2)
        text(draw, (177, y), label, "small", MUTED, "lm")
        text(draw, (816, y), value, "small_bold", INK if visible else FAINT, "rm")

    completed = t > 0.57
    button_fill = GREEN if completed else CYAN
    draw.rounded_rectangle((618, 414, 816, 454), radius=20, fill=button_fill)
    text(draw, (717, 434), "제출 완료" if completed else "분석 제출", "small_bold", "#04120E" if completed else "#041018", "mm")
    if completed:
        halo = 21 + pulse(t) * 8
        draw.ellipse((570 - halo, 434 - halo, 570 + halo, 434 + halo), outline=rgba(GREEN, 130), width=2)
        draw.ellipse((557, 421, 583, 447), fill=GREEN)
        draw.line((564, 434, 569, 439, 578, 428), fill="#04120E", width=3)
    else:
        cursor(draw, 714, 431, max(0.0, min(1.0, (t - 0.42) * 7)))
    progress(draw, 5)
    return image


GUIDES: tuple[tuple[str, Callable[[int], Image.Image], int], ...] = (
    ("01-star-select", frame_star_select, 25),
    ("02-bls-peak", frame_bls_peak, 26),
    ("03-transit-interval", frame_transit_interval, 27),
    ("04-judgment", frame_judgment, 27),
    ("05-submission", frame_submission, 29),
)


def save_gif(frames: Iterable[Image.Image], path: Path) -> None:
    rendered = [frame.convert("RGB") for frame in frames]
    rendered[0].save(
        path,
        save_all=True,
        append_images=rendered[1:],
        duration=FRAME_MS,
        loop=0,
        optimize=False,
        disposal=2,
    )


def generate(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for basename, renderer, poster_frame in GUIDES:
        frames = [renderer(index) for index in range(FRAME_COUNT)]
        save_gif(frames, output_dir / f"{basename}.gif")
        frames[poster_frame].convert("RGB").save(output_dir / f"{basename}.png", optimize=True)
        print(f"created {basename}.gif and {basename}.png")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="directory for GIF and PNG files (default: beside this script)",
    )
    args = parser.parse_args()
    generate(args.output.resolve())


if __name__ == "__main__":
    main()
