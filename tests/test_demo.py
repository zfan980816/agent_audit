from agentaudit.demo import write_demo_session
from agentaudit.engine import run_audit


def test_demo_triggers_many_rules(tmp_path):
    path = write_demo_session(tmp_path)
    result = run_audit([path])
    ids = {f.rule_id for f in result.findings}
    assert {"D001", "D002", "C001", "E001", "E003", "U001", "B006", "E005",
            "B001", "B004"} <= ids
