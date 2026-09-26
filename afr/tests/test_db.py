"""DB adapter tests: config resolution, placeholder translation, row facade,
SQL hygiene (no literal `?` / bare `%` inside SQL strings — keeps the
`?`-translation blind-regex safe on every backend)."""

import re
import tokenize
from pathlib import Path

import pytest

from afr import db
from afr.capture import connect

_SQL_KW = re.compile(r"\b(select|insert|update|delete|create|alter)\b", re.I)


# -- config resolution -------------------------------------------------------
def test_resolve_precedence_param_beats_all(monkeypatch, tmp_path):
    monkeypatch.setenv("AFR_DB_URL", "mysql://u:p@h:3306/x")
    cfg = tmp_path / "config.json"
    cfg.write_text('{"db_url": "dm://u:p@h:5236"}', encoding="utf-8")
    monkeypatch.setattr(db, "CONFIG_PATH", cfg)
    assert db.resolve_db_url("sqlite:///p.db") == "sqlite:///p.db"


def test_resolve_precedence_env_beats_config(monkeypatch, tmp_path):
    monkeypatch.setenv("AFR_DB_URL", "mysql://u:p@h:3306/x")
    cfg = tmp_path / "config.json"
    cfg.write_text('{"db_url": "dm://u:p@h:5236"}', encoding="utf-8")
    monkeypatch.setattr(db, "CONFIG_PATH", cfg)
    assert db.resolve_db_url(None) == "mysql://u:p@h:3306/x"


def test_resolve_config_file(monkeypatch, tmp_path):
    monkeypatch.delenv("AFR_DB_URL", raising=False)
    cfg = tmp_path / "config.json"
    cfg.write_text('{"db_url": "dm://u:p@h:5236?schema=AFR"}', encoding="utf-8")
    monkeypatch.setattr(db, "CONFIG_PATH", cfg)
    assert db.resolve_db_url(None) == "dm://u:p@h:5236?schema=AFR"


def test_resolve_default_when_nothing_configured(monkeypatch):
    monkeypatch.delenv("AFR_DB_URL", raising=False)
    monkeypatch.setattr(db, "CONFIG_PATH", Path("/nonexistent/config.json"))
    assert db.resolve_db_url(None) == db.DEFAULT_URL


def test_resolve_coerces_bare_path(monkeypatch):
    monkeypatch.delenv("AFR_DB_URL", raising=False)
    assert db.resolve_db_url("D:/x/y.db") == "sqlite:///D:/x/y.db"
    assert db.resolve_db_url(r"C:\x\y.db") == "sqlite:///C:/x/y.db"


def test_mask_password():
    assert db.mask_password("mysql://u:secret@h:3306/x") == \
        "mysql://u:***@h:3306/x"
    assert db.mask_password("sqlite:///plain.db") == "sqlite:///plain.db"


# -- placeholder translation ---------------------------------------------------
def test_translate_mysql_rewrites_qmark():
    assert db.translate("SELECT * FROM t WHERE a=? AND b=?", db.DIALECTS["mysql"]) \
        == "SELECT * FROM t WHERE a=%s AND b=%s"


def test_translate_sqlite_and_dm_are_noops():
    for name in ("sqlite", "dm"):
        assert db.translate("WHERE a=?", db.DIALECTS[name]) == "WHERE a=?"


# -- row facade ------------------------------------------------------------------
def test_row_supports_dict_and_positional_access(tmp_path):
    conn = connect(tmp_path / "t.db")
    conn.execute("INSERT INTO runs(id, label) VALUES(?,?)", ("r1", "L"))
    conn.commit()
    row = conn.execute("SELECT id, label FROM runs WHERE id=?", ("r1",)).fetchone()
    assert row["id"] == "r1" and row[0] == "r1"
    assert row["label"] == "L" and row[1] == "L"
    rows = conn.execute("SELECT id FROM runs").fetchall()
    assert len(rows) == 1 and rows[0]["id"] == "r1"
    conn.close()


def test_cursor_is_iterable(tmp_path):
    conn = connect(tmp_path / "t.db")
    for i in range(3):
        conn.execute("INSERT INTO runs(id) VALUES(?)", (f"r{i}",))
    conn.commit()
    ids = [r["id"] for r in conn.execute("SELECT id FROM runs ORDER BY id")]
    assert ids == ["r0", "r1", "r2"]
    conn.close()


def test_fetchone_returns_none_when_empty(tmp_path):
    conn = connect(tmp_path / "t.db")
    assert conn.execute("SELECT id FROM runs WHERE id=?", ("zz",)).fetchone() \
        is None
    conn.close()


# -- open() error paths -----------------------------------------------------
def test_open_unknown_scheme_raises():
    with pytest.raises(db.ConfigurationError):
        db.open("postgres://x/y")


def test_open_corrupt_sqlite_raises_database_error(tmp_path):
    bad = tmp_path / "bad.db"
    bad.write_bytes(b"not a sqlite file at all")
    with pytest.raises(db.DatabaseError):
        db.open(str(bad))


# -- mysql / dm DDL ----------------------------------------------------------
def test_ddl_template_renders_fully_for_both_backends():
    for auto in ("BIGINT AUTO_INCREMENT", "BIGINT IDENTITY(1,1)"):
        for json_type in ("LONGTEXT", "CLOB"):
            for ddl in db._TABLES.values():
                rendered = ddl.format(auto=auto, json=json_type)
                assert "{" not in rendered and "}" not in rendered
    assert len(db._TABLES) == 4 and len(db._INDEXES) == 3


# -- SQL hygiene -----------------------------------------------------------
# The `?`-translation is a blind regex; it is only safe if a literal `?`
# never appears INSIDE a quoted SQL literal, and PyMySQL interpolation is
# only safe if no bare `%` appears OUTSIDE quoted literals. Bind such
# values as parameters instead.
_PY_SOURCES = sorted(Path(db.__file__).parent.glob("*.py"))
_QUOTED = re.compile(r"'[^']*'")


def _string_literals(path):
    with path.open("rb") as f:
        for tok in tokenize.tokenize(f.readline):
            if tok.type == tokenize.STRING:
                yield tok.string


def test_sql_strings_have_no_literal_qmark_or_bare_percent():
    offenders = []
    for path in _PY_SOURCES:
        for lit in _string_literals(path):
            inner = lit[1:-1]
            if not _SQL_KW.search(inner):
                continue
            for q in _QUOTED.findall(inner):
                if "?" in q:
                    offenders.append(f"{path.name}: 引号内字面 ? -> {lit[:60]}")
            if "%" in _QUOTED.sub("", inner):
                offenders.append(f"{path.name}: 引号外裸 % -> {lit[:60]}")
    assert not offenders, f"SQL 卫生违规（改为参数绑定）: {offenders}"
