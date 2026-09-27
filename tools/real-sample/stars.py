"""Stars of the real TESS demo sample and the external facts the repo already holds.

Only information present in this repository is used for labels:
- experiments/tess-fixture/references.csv (NASA Exoplanet Archive pscomppars rows)
- experiments/tess-fixture/configs/service_sample_v1.json (planet_host notes)
- docs/data/tess-service-scope-v1.md 9.8-9.13 (tutorial EB / FP evidence)
- experiments/tess-bench/tess_bench/tutorial_labels.py (L 98-59 c, TOI 184.01, Rowden A/B)
A kernel candidate gets a label only when it matches one of these rows (see run.py).
Anything else stays an unconfirmed candidate.
"""

# SPOC 2-minute LC product naming (experiments/tess-fixture/tess_fixture/targets.py).
SECTOR_PRODUCT_PREFIX = {2: ("tess2018234235059", "0121"), 3: ("tess2018263035959", "0123"),
                         4: ("tess2018292075959", "0124"), 5: ("tess2018319095959", "0125")}
MAST_DOWNLOAD = "https://mast.stsci.edu/api/v0.1/Download/file/?uri=mast:TESS/product/"


def product_filename(tic: int, sector: int) -> str:
    prefix, pipeline = SECTOR_PRODUCT_PREFIX[sector]
    return f"{prefix}-s{sector:04d}-{tic:016d}-{pipeline}-s_lc.fits"


# role, tutorialSeq, display name, sector, why it is in the sample
STARS = [
    # Tutorials: docs/data/tess-service-scope-v1.md 9.4-9.13 (S15P21C206-109 selection).
    dict(tic=149603524, role="tutorial", seq=1, name="WASP-62", sectors=[2], why="tutorial 1: clear confirmed planet"),
    dict(tic=307210830, role="tutorial", seq=2, name="L 98-59", sectors=[2], why="tutorial 2: shallow confirmed planets"),
    dict(tic=279569718, role="tutorial", seq=3, name="TIC 279569718", sectors=[3], why="tutorial 3: not a planet (EB)"),
    dict(tic=300871545, role="tutorial", seq=4, name="TOI-184", sectors=[3], why="tutorial 4: deep EB (TOI 184.01, FP)"),
    dict(tic=278956474, role="tutorial", seq=5, name="TIC 278956474", sectors=[3], why="tutorial 5: two EBs, repeated removal"),
    # Explore, Sector 3 stars already in the repo's data docs and benchmarks.
    dict(tic=259377017, role="explore", name="TOI-270", sectors=[3, 4, 5],
         why="fixture: three confirmed planets (S3 alone fails removal QA; S3-5 as in 109 9.6)"),
    dict(tic=100100827, role="explore", name="WASP-18", sectors=[3], why="fixture: deep hot Jupiter"),
    dict(tic=439456714, role="explore", name="TOI-277", sectors=[3], why="service sample planet_host (3.994 d)"),
    dict(tic=100990000, role="explore", name="HD 22946", sectors=[3], why="service sample planet_host (4.04 d)"),
    dict(tic=150428135, role="explore", name="TOI-700", sectors=[3, 4, 5],
         why="fixture: shallow long-period planets (S3-5 as in 109 9.6)"),
    dict(tic=279741379, role="explore", name="HD 21749", sectors=[3], why="fixture: long period + shallow"),
    dict(tic=272357134, role="explore", name="TIC 272357134", sectors=[3], why="TESS-EBs S3 EB (FP)"),
    dict(tic=30313682, role="explore", name="TIC 30313682", sectors=[3], why="TESS-EBs S3 EB (FP, half period)"),
    dict(tic=176984144, role="explore", name="TIC 176984144", sectors=[3], why="service sample random: unlabeled candidate"),
    dict(tic=166711424, role="explore", name="TIC 166711424", sectors=[3], why="service sample random: gate pass"),
    dict(tic=294754816, role="explore", name="TIC 294754816", sectors=[3], why="service sample random: gate pass"),
    dict(tic=25399578, role="explore", name="TIC 25399578", sectors=[3], why="service sample random: no quality peak"),
    dict(tic=35703725, role="explore", name="TIC 35703725", sectors=[3], why="service sample random: no quality peak"),
    dict(tic=268637577, role="explore", name="TIC 268637577", sectors=[3], why="holdout / random"),
    dict(tic=219237079, role="explore", name="TIC 219237079", sectors=[3], why="holdout / random"),
]

# External rows. kind: confirmed | fp | candidate. epoch_btjd None = period-only evidence.
# `multiple`: row period = kernel period * multiple is also accepted (EB found at P/2).
ARCHIVE = "NASA Exoplanet Archive"
REFS = {
    149603524: [dict(label="WASP-62 b", planet="WASP-62 b", kind="confirmed", source=ARCHIVE, disposition="CP",
                     period=4.41195, epoch=2458851.099338 - 2457000, duration=3.816, radius_earth=14.79588,
                     year=2012, repo="experiments/tess-fixture/references.csv")],
    307210830: [
        dict(label="L 98-59 b", planet="L 98-59 b", kind="confirmed", source=ARCHIVE, disposition="CP",
             period=2.253114, epoch=2458366.17056 - 2457000, duration=1.01, radius_earth=0.837, year=2019,
             repo="experiments/tess-fixture/references.csv"),
        dict(label="L 98-59 c", planet="L 98-59 c", kind="confirmed", source=ARCHIVE, disposition="CP",
             period=3.6906777, epoch=1367.27375, duration=1.346, radius_earth=1.329, year=2019,
             repo="experiments/tess-bench/tess_bench/tutorial_labels.py L98 (Demangeon Table 3)"),
        dict(label="L 98-59 d", planet="L 98-59 d", kind="confirmed", source=ARCHIVE, disposition="CP",
             period=7.450729, epoch=2458362.74002 - 2457000, duration=0.84, radius_earth=1.627, year=2019,
             repo="experiments/tess-fixture/references.csv"),
    ],
    279569718: [dict(label="TESS-EBs TIC 279569718", kind="fp", source="TESS-EBs v1.0", disposition="EB",
                     period=3.9794273677, epoch=None, duration=None,
                     repo="docs/data/tess-service-scope-v1.md 9.8, 9.13 (DV 1 allTransitsFit)")],
    300871545: [dict(label="TOI-184.01", kind="fp", source="TOI", disposition="FP",
                     period=4.817028, epoch=1327.376627, duration=3.194467,
                     repo="docs/data/tess-service-scope-v1.md 9.11 (SPOC alerts PC, ExoFOP TFOPWG FP / EB)")],
    278956474: [
        dict(label="Rowden 2020 EB A", kind="fp", source="Rowden et al. 2020", disposition="EB",
             period=5.488, epoch=1327.9619, duration=5.43,
             repo="docs/data/tess-service-scope-v1.md 9.12-9.13; tutorial_labels.py literature A"),
        dict(label="Rowden 2020 EB B", kind="fp", source="Rowden et al. 2020", disposition="EB",
             period=5.67435, epoch=1330.6875, duration=3.34,
             repo="docs/data/tess-service-scope-v1.md 9.12-9.13; tutorial_labels.py literature B"),
    ],
    259377017: [
        dict(label="TOI-270 b", planet="TOI-270 b", kind="confirmed", source=ARCHIVE, disposition="CP",
             period=3.35992, epoch=2458461.01464 - 2457000, duration=1.294, radius_earth=1.28, year=2019,
             repo="experiments/tess-fixture/references.csv"),
        dict(label="TOI-270 c", planet="TOI-270 c", kind="confirmed", source=ARCHIVE, disposition="CP",
             period=5.66051, epoch=2458463.08056 - 2457000, duration=1.682, radius_earth=2.33, year=2019,
             repo="experiments/tess-fixture/references.csv"),
        dict(label="TOI-270 d", planet="TOI-270 d", kind="confirmed", source=ARCHIVE, disposition="CP",
             period=11.38194, epoch=2458469.33823 - 2457000, duration=2.117, radius_earth=2.0, year=2019,
             repo="experiments/tess-fixture/references.csv"),
    ],
    100100827: [dict(label="WASP-18 b", planet="WASP-18 b", kind="confirmed", source=ARCHIVE, disposition="CP",
                     period=0.94145223, epoch=2456740.8056 - 2457000, duration=2.21, radius_earth=13.89913607,
                     year=2009, repo="experiments/tess-fixture/references.csv")],
    439456714: [dict(label="TOI-277 b", planet="TOI-277 b", kind="confirmed", source=ARCHIVE, disposition="CP",
                     period=3.994, epoch=None, duration=None,
                     repo="docs/data/tess-service-scope-v1.md 5.3; configs/service_sample_v1.json note")],
    100990000: [dict(label="HD 22946 (4.040295 d)", kind="confirmed", source=ARCHIVE, disposition="CP",
                     period=4.040295, epoch=None, duration=None,
                     repo="docs/data/tess-service-scope-v1.md 5.3")],
    150428135: [
        dict(label=f"TOI-700 {p}", planet=f"TOI-700 {p}", kind="confirmed", source=ARCHIVE, disposition="CP",
             period=period, epoch=epoch - 2457000, duration=duration, radius_earth=radius, year=year,
             repo="experiments/tess-fixture/references.csv")
        for p, period, epoch, duration, radius, year in [
            ("b", 9.977219, 2458880.0993, 2.17, 0.914, 2020), ("c", 16.051137, 2458821.62181, 1.42, 2.6, 2020),
            ("e", 27.80978, 2458964.8112, 2.777, 0.953, 2023), ("d", 37.42396, 2458816.9952, 3.314, 1.073, 2020)]
    ],
    279741379: [
        dict(label="HD 21749 c", planet="HD 21749 c", kind="confirmed", source=ARCHIVE, disposition="CP",
             period=7.78993, epoch=2458371.2287 - 2457000, duration=2.515, radius_earth=0.892, year=2019,
             repo="experiments/tess-fixture/references.csv"),
        dict(label="GJ 143 b", planet="GJ 143 b", kind="confirmed", source=ARCHIVE, disposition="CP",
             period=35.61253, epoch=2458385.92502 - 2457000, duration=3.23, radius_earth=2.61, year=2019,
             repo="experiments/tess-fixture/references.csv"),
    ],
    272357134: [dict(label="TESS-EBs TIC 272357134", kind="fp", source="TESS-EBs v1.0", disposition="EB",
                     period=4.196949, epoch=None, duration=None, repo="docs/data/tess-service-scope-v1.md 9.8")],
    30313682: [dict(label="TESS-EBs TIC 30313682", kind="fp", source="TESS-EBs v1.0", disposition="EB",
                    period=5.727367, epoch=None, duration=None, multiple=2.0,
                    repo="docs/data/tess-service-scope-v1.md 9.8 (kernel finds the half period)")],
}
