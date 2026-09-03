from semi_auto_bls import EXAMPLE_TARGETS


def test_example_target_presets_have_unique_sources_and_supported_kinds():
    targets = list(EXAMPLE_TARGETS.values())

    assert len(targets) == 3
    assert len({target["tic_id"] for target in targets}) == len(targets)
    assert len({str(target["data_dir"]) for target in targets}) == len(targets)
    assert len({target["download_script"] for target in targets}) == len(targets)
    assert {target["kind"] for target in targets} == {
        "planetary_system",
        "eclipsing_binary",
    }


def test_cm_dra_is_the_only_eclipsing_binary_preset():
    binaries = [
        target for target in EXAMPLE_TARGETS.values()
        if target["kind"] == "eclipsing_binary"
    ]

    assert len(binaries) == 1
    assert binaries[0]["name"] == "CM Draconis"
    assert binaries[0]["tic_id"] == 199574208
    assert binaries[0]["sectors"] == (16,)
