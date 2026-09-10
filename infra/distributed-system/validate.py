"""Run from any directory: python infra/distributed-system/validate.py."""
from pathlib import Path
import xml.etree.ElementTree as ET

BASE = Path(__file__).resolve().parent


def properties(path):
    root = ET.parse(path).getroot()
    assert root.tag == "configuration", path
    pairs = [(p.findtext("name"), p.findtext("value")) for p in root]
    assert all(k and v for k, v in pairs), path
    assert len(dict(pairs)) == len(pairs), f"duplicate properties: {path}"
    return dict(pairs)


def main():
    hadoop = BASE / "config/hadoop"
    assert properties(hadoop / "core-site.xml")["fs.defaultFS"] == "hdfs://planetory"
    hdfs = properties(hadoop / "hdfs-site.xml")
    assert hdfs["dfs.ha.namenodes.planetory"] == "nn1,nn2"
    assert hdfs["dfs.ha.automatic-failover.enabled"] == "false"
    assert hdfs["dfs.namenode.shared.edits.dir"] == (
        "qjournal://master-1:8485;worker-2:8485;worker-3:8485/planetory"
    )
    assert hdfs["dfs.datanode.data.dir"] == "file:///mnt/data/hdfs"
    assert hdfs["dfs.replication"] == "2"
    assert (hadoop / "workers").read_text().splitlines() == [f"worker-{i}" for i in range(2, 7)]
    profiles = {}
    for role, memory, cores in [("worker", "24576", "3"), ("standby-worker", "16384", "2")]:
        props = properties(BASE / f"config/yarn/{role}.xml")
        assert props["yarn.nodemanager.resource.memory-mb"] == memory
        assert props["yarn.nodemanager.resource.cpu-vcores"] == cores
        assert props["yarn.scheduler.maximum-allocation-mb"] == "24576"
        for key in ("yarn.nodemanager.local-dirs", "yarn.nodemanager.log-dirs"):
            assert props[key].startswith("/mnt/data/yarn/")
        profiles[role] = props
    differing = {k for k in profiles["worker"] if profiles["worker"][k] != profiles["standby-worker"].get(k)}
    assert differing == {"yarn.nodemanager.resource.memory-mb", "yarn.nodemanager.resource.cpu-vcores"}
    assert profiles["worker"].keys() == profiles["standby-worker"].keys()
    for name in ("compose.control-plane.yaml", "compose.worker.yaml"):
        compose = (BASE / name).read_text(encoding="utf-8")
        for i in range(1, 7):
            host = "master-1" if i == 1 else f"worker-{i}"
            project = f"GCP_NODE_{i}_PROJECT"
            assert f'"{host}=10.20.{i}.10"' in compose
            assert (
                f'"{host}.${{GCP_ZONE:-asia-east1-b}}.c.'
                f'${{{project}:?Set {project}}}.internal=10.20.{i}.10"'
            ) in compose
            assert (
                f'"{host}.c.${{{project}:?Set {project}}}.internal=10.20.{i}.10"'
            ) in compose
        assert "HADOOP_CONF_DIR: /etc/hadoop" in compose
        assert "YARN_CONF_DIR: /etc/hadoop" in compose
    print("PASS: XML, RF2, 5 workers, role limits and short/FQDN host mappings")


if __name__ == "__main__":
    main()
