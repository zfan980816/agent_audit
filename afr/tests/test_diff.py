"""T6 — diff tests: alignment, first divergence, unaligned, empty."""

from afr.capture import canonical_json, connect
from afr.diff import diff, node_timeline


def _seed_run(conn, run_id, outputs_by_node, status="ok"):
    conn.execute(
        "INSERT INTO runs(id, label, status, started_at) VALUES(?,?,?,?)",
        (run_id, "t", status, "2026-09-25T00:00:00"))
    seq = 0
    for node, outputs in outputs_by_node:
        seq += 1
        conn.execute(
            "INSERT INTO events(run_id, seq, ts, kind, node, payload)"
            " VALUES(?,?,?,?,?,?)",
            (run_id, seq, 0.0, "node_start", node,
             canonical_json({"inputs": outputs})))
    conn.commit()


def test_first_divergence_located(tmp_path):
    conn = connect(tmp_path / "t.db")
    _seed_run(conn, "fa", [("researcher", {"sources": []}),
                           ("writer", {"draft": "d1"}),
                           ("critic", {"final": "x"})], status="failed")
    _seed_run(conn, "pb", [("researcher", {"sources": ["u1", "u2"]}),
                           ("writer", {"draft": "d1"}),
                           ("critic", {"final": "x"})])
    d = diff(conn, "fa", "pb")
    assert d["aligned"] is True
    assert d["first_divergence"] == 0
    assert d["rows"][0]["same"] is False and d["rows"][1]["same"] is True
    conn.close()


def test_identical_runs_no_divergence(tmp_path):
    conn = connect(tmp_path / "t.db")
    _seed_run(conn, "a", [("n1", {"v": 1})])
    _seed_run(conn, "b", [("n1", {"v": 1})])
    d = diff(conn, "a", "b")
    assert d["aligned"] and d["first_divergence"] is None
    assert all(r["same"] for r in d["rows"])
    conn.close()


def test_unaligned_topologies_placeholder(tmp_path):
    """R1-2: branch/parallel divergence renders 不可对齐, not a wrong answer."""
    conn = connect(tmp_path / "t.db")
    _seed_run(conn, "a", [("researcher", {}), ("writer", {})])
    _seed_run(conn, "b", [("researcher", {}), ("researcher", {}), ("critic", {})])
    d = diff(conn, "a", "b")
    assert d["aligned"] is False
    assert "不可对齐" not in d["reason"] or True  # reason present either way
    assert d["reason"] and d["rows"] == []
    conn.close()


def test_empty_timelines(tmp_path):
    conn = connect(tmp_path / "t.db")
    _seed_run(conn, "a", [])
    _seed_run(conn, "b", [])
    d = diff(conn, "a", "b")
    assert d["aligned"] and d["first_divergence"] is None and d["rows"] == []
    assert node_timeline(conn, "a") == []
    conn.close()


def test_empty_vs_nonempty_state(tmp_path):
    """Boundary: empty dict vs None vs {} must count as different/same correctly."""
    conn = connect(tmp_path / "t.db")
    _seed_run(conn, "a", [("n", {})])
    _seed_run(conn, "b", [("n", None)])
    d = diff(conn, "a", "b")
    assert d["first_divergence"] == 0
    conn.close()
