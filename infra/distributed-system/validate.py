"""Run from any directory: python infra/distributed-system/validate.py."""
from pathlib import Path
import ast
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
        assert props["yarn.scheduler.minimum-allocation-mb"] == "1024"
        assert props["yarn.scheduler.maximum-allocation-vcores"] == "3"
        assert props["yarn.resourcemanager.scheduler.class"].endswith(".CapacityScheduler")
        assert props["yarn.resourcemanager.resource-tracker.address"] == "master-1:8031"
        assert props["yarn.resourcemanager.address"] == "master-1:8032"
        assert props["yarn.nodemanager.address"] == "0.0.0.0:8041"
        assert props["yarn.nodemanager.pmem-check-enabled"] == "true"
        assert props["yarn.nodemanager.vmem-check-enabled"] == "false"
        assert props["yarn.log-aggregation-enable"] == "true"
        assert props["yarn.log-aggregation.retain-seconds"] == "604800"
        for key in ("yarn.nodemanager.local-dirs", "yarn.nodemanager.log-dirs"):
            assert props[key].startswith("/mnt/data/yarn/")
        profiles[role] = props
    differing = {k for k in profiles["worker"] if profiles["worker"][k] != profiles["standby-worker"].get(k)}
    assert differing == {"yarn.nodemanager.resource.memory-mb", "yarn.nodemanager.resource.cpu-vcores"}
    assert profiles["worker"].keys() == profiles["standby-worker"].keys()
    capacity = properties(BASE / "config/yarn/capacity-scheduler.xml")
    assert capacity["yarn.scheduler.capacity.root.queues"] == "default"
    assert capacity["yarn.scheduler.capacity.root.default.capacity"] == "100"
    assert capacity["yarn.scheduler.capacity.root.default.maximum-capacity"] == "100"
    assert capacity["yarn.scheduler.capacity.root.default.state"] == "RUNNING"
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
    installer = (BASE / "scripts/install-hdfs-host.sh").read_text(encoding="utf-8")
    for required in (
        'HADOOP_VERSION="3.5.0"',
        "openjdk-17-jdk-headless",
        "sha512sum --check",
        "User=hdfs",
        "RequiresMountsFor=",
        "roles=(namenode journalnode datanode)",
        "roles=(journalnode datanode)",
        "roles=(datanode)",
    ):
        assert required in installer, required
    for forbidden in ("hdfs namenode -format", "-bootstrapStandby", "-initializeSharedEdits"):
        assert forbidden not in installer, forbidden
    orchestrator = (BASE / "scripts/install-hdfs-hosts.ps1").read_text(encoding="utf-8")
    assert "SupportsShouldProcess" in orchestrator
    assert "Install Node 1 alone" in orchestrator
    assert "Invoke-Tailscale ssh" in orchestrator
    assert "Invoke-Scp" in orchestrator
    assert "SSAFY" in orchestrator and "planetory-admin" in orchestrator
    assert "gcloud" not in orchestrator
    yarn_installer = (BASE / "scripts/install-yarn-host.sh").read_text(encoding="utf-8")
    for required in (
        "User=yarn",
        "role=resourcemanager",
        "role=nodemanager",
        "docker.io docker-compose-v2",
        "Worker Python 3.12",
        "capacity-scheduler.xml",
    ):
        assert required in yarn_installer, required
    assert yarn_installer.index('systemctl is-active --quiet "$unit"') < yarn_installer.index(
        'install -o root -g root -m 0644 "$source_dir/$profile"'
    )
    yarn_orchestrator = (BASE / "scripts/install-yarn-hosts.ps1").read_text(encoding="utf-8")
    assert "SupportsShouldProcess" in yarn_orchestrator
    assert "Install Node 1 alone" in yarn_orchestrator
    assert "Invoke-Tailscale ssh" in yarn_orchestrator
    assert "BatchMode=yes" in yarn_orchestrator and "StrictHostKeyChecking=yes" in yarn_orchestrator
    initializer = (BASE / "scripts/initialize-yarn-cluster.ps1").read_text(encoding="utf-8")
    assert "ValidateNodes" in initializer and "FinalAudit" in initializer
    assert "planetory-yarn-private" in initializer
    assert "planetory-spark-private" in initializer and "7079:7095" in initializer
    assert "10.20.1.10 10.20.2.10 10.20.3.10 10.20.4.10 10.20.5.10 10.20.6.10" in initializer
    assert "Default: deny \\(incoming\\)" in initializer
    assert "active:standby|standby:active" in initializer
    assert "base64 --decode | bash" in initializer
    assert "hadoop-yarn-*.log.[0-9]*" in initializer
    sample_runner = (BASE / "scripts/run-yarn-sample.ps1").read_text(encoding="utf-8")
    assert "--master yarn --deploy-mode cluster" in sample_runner
    assert "spark.executor.instances=5" in sample_runner
    assert "spark.driver.port=7078" in sample_runner
    assert "spark.blockManager.port=7079" in sample_runner
    assert "application -list -appStates RUNNING" in sample_runner
    assert "application -kill" in sample_runner and "docker rm -f" in sample_runner
    assert "for host in worker-2 worker-3 worker-4 worker-5 worker-6" in sample_runner
    assert "Final-State" in sample_runner and "SUCCEEDED" in sample_runner
    assert "active:standby|standby:active" in sample_runner
    assert "sudo -n journalctl -k" in sample_runner and "dmesg" not in sample_runner
    assert "base64 --decode | bash" in sample_runner
    assert "BatchMode=yes" in sample_runner and "StrictHostKeyChecking=yes" in sample_runner
    forbidden_commands = (
        "ufw disable",
        "ufw reset",
        "ufw --force reset",
        "namenode -format",
        "dfs -rm",
        "haadmin -failover",
        "haadmin -transitionToActive",
        "haadmin -transitionToStandby",
        "dfsadmin -safemode",
        "dfs -expunge",
    )
    for script in (yarn_installer, initializer, sample_runner):
        for forbidden in forbidden_commands:
            assert forbidden not in script, forbidden
    ast.parse((BASE / "scripts/yarn-hdfs-sample.py").read_text(encoding="utf-8"))
    print("PASS: HDFS/YARN config, host mappings and safe installer/sample contracts")


if __name__ == "__main__":
    main()
