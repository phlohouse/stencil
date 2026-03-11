import json
import subprocess
import webbrowser
from pathlib import Path

import pytest

import stencilpy.cli as cli
from stencilpy.cli import main


class TestCLI:
    def test_no_command_returns_1(self):
        assert main([]) == 1

    def test_extract_single_file(self, sample_schema_yaml, sample_excel_v2, capsys):
        result = main(["extract", str(sample_schema_yaml), str(sample_excel_v2)])
        assert result == 0
        output = json.loads(capsys.readouterr().out)
        assert output["patient_name"] == "Jane Doe"

    def test_extract_pretty(self, sample_schema_yaml, sample_excel_v2, capsys):
        result = main(["extract", str(sample_schema_yaml), str(sample_excel_v2), "--pretty"])
        assert result == 0
        raw = capsys.readouterr().out
        assert "\n" in raw
        output = json.loads(raw)
        assert output["patient_name"] == "Jane Doe"

    def test_extract_forced_version(self, sample_schema_yaml, sample_excel_v2, capsys):
        result = main(["extract", str(sample_schema_yaml), str(sample_excel_v2), "--version", "v2.0"])
        assert result == 0
        output = json.loads(capsys.readouterr().out)
        assert output["patient_name"] == "Jane Doe"

    def test_extract_forced_version_unknown(self, sample_schema_yaml, sample_excel_v2, capsys):
        result = main(["extract", str(sample_schema_yaml), str(sample_excel_v2), "--version", "v99"])
        assert result == 1
        assert "not found" in capsys.readouterr().err

    def test_extract_bad_file(self, sample_schema_yaml, sample_excel_bad_disc, capsys):
        result = main(["extract", str(sample_schema_yaml), str(sample_excel_bad_disc)])
        assert result == 1
        assert "Error" in capsys.readouterr().err

    def test_extract_directory(self, sample_schema_yaml, sample_excel_v2, sample_excel_v1, tmp_path, capsys):
        batch_dir = tmp_path / "batch"
        batch_dir.mkdir()
        (batch_dir / sample_excel_v2.name).write_bytes(sample_excel_v2.read_bytes())
        (batch_dir / sample_excel_v1.name).write_bytes(sample_excel_v1.read_bytes())
        result = main(["extract", str(sample_schema_yaml), str(batch_dir), "--no-progress"])
        assert result == 0
        output = json.loads(capsys.readouterr().out)
        assert isinstance(output, list)
        assert len(output) == 2

    def test_extract_schema_not_found(self, tmp_path, capsys):
        result = main(["extract", str(tmp_path / "nope.yaml"), str(tmp_path / "nope.xlsx")])
        assert result == 1
        assert "Error" in capsys.readouterr().err

    def test_open_defaults_to_editor_url(self, monkeypatch, capsys):
        opened_urls: list[str] = []

        def fake_open(url: str, *_args: object, **_kwargs: object) -> bool:
            opened_urls.append(url)
            return True

        monkeypatch.setattr(cli, "_is_url_listening", lambda _url: True)
        monkeypatch.setattr(webbrowser, "open", fake_open)

        result = main(["open"])

        assert result == 0
        assert opened_urls == ["http://localhost:5173"]
        assert capsys.readouterr().out.strip() == "http://localhost:5173"

    def test_open_custom_url(self, monkeypatch, capsys):
        opened_urls: list[str] = []

        def fake_open(url: str, *_args: object, **_kwargs: object) -> bool:
            opened_urls.append(url)
            return True

        monkeypatch.setattr(webbrowser, "open", fake_open)

        result = main(["open", "http://localhost:3000"])

        assert result == 0
        assert opened_urls == ["http://localhost:3000"]
        assert capsys.readouterr().out.strip() == "http://localhost:3000"

    def test_open_failure_returns_1(self, monkeypatch, capsys):
        monkeypatch.setattr(cli, "_is_url_listening", lambda _url: True)
        monkeypatch.setattr(webbrowser, "open", lambda *_args, **_kwargs: False)

        result = main(["open"])

        assert result == 1
        assert "could not open" in capsys.readouterr().err

    def test_open_starts_editor_when_default_url_is_not_running(self, monkeypatch, capsys, tmp_path):
        opened_urls: list[str] = []
        popen_calls: list[dict[str, object]] = []
        listening_checks = iter([False, True])
        process = FakeProcess()

        def fake_open(url: str, *_args: object, **_kwargs: object) -> bool:
            opened_urls.append(url)
            return True

        def fake_popen(*args: object, **kwargs: object) -> object:
            popen_calls.append({"args": args, "kwargs": kwargs})
            return process

        monkeypatch.setattr(cli, "_find_editor_dir", lambda: tmp_path / "editor")
        monkeypatch.setattr(cli, "_is_url_listening", lambda _url: next(listening_checks))
        monkeypatch.setattr(cli.time, "sleep", lambda _seconds: None)
        monkeypatch.setattr(subprocess, "Popen", fake_popen)
        monkeypatch.setattr(webbrowser, "open", fake_open)

        result = main(["open"])

        assert result == 0
        assert len(popen_calls) == 1
        assert popen_calls[0]["args"] == (["npm", "run", "dev"],)
        assert popen_calls[0]["kwargs"]["cwd"] == tmp_path / "editor"
        assert popen_calls[0]["kwargs"]["stdout"] is subprocess.DEVNULL
        assert popen_calls[0]["kwargs"]["stderr"] is subprocess.DEVNULL
        assert process.wait_calls == 1
        assert opened_urls == [cli.DEFAULT_EDITOR_URL]
        assert capsys.readouterr().out.strip() == cli.DEFAULT_EDITOR_URL

    def test_open_returns_1_when_editor_dir_is_missing(self, monkeypatch, capsys):
        monkeypatch.setattr(cli, "_is_url_listening", lambda _url: False)
        monkeypatch.setattr(cli, "_find_editor_dir", lambda: None)

        result = main(["open"])

        assert result == 1
        assert "could not find the editor project" in capsys.readouterr().err

    def test_open_does_not_start_editor_for_custom_url(self, monkeypatch, capsys):
        opened_urls: list[str] = []

        def fake_open(url: str, *_args: object, **_kwargs: object) -> bool:
            opened_urls.append(url)
            return True

        def unexpected_popen(*_args: object, **_kwargs: object) -> object:
            raise AssertionError("custom URLs should not start the editor dev server")

        monkeypatch.setattr(subprocess, "Popen", unexpected_popen)
        monkeypatch.setattr(webbrowser, "open", fake_open)

        result = main(["open", "http://localhost:3000"])

        assert result == 0
        assert opened_urls == ["http://localhost:3000"]

    def test_open_returns_130_when_started_process_is_interrupted(self, monkeypatch, capsys, tmp_path):
        process = FakeProcess()
        listening_checks = iter([False, True])
        waited_on: list[FakeProcess] = []

        monkeypatch.setattr(cli, "_find_editor_dir", lambda: tmp_path / "editor")
        monkeypatch.setattr(cli, "_is_url_listening", lambda _url: next(listening_checks))
        monkeypatch.setattr(cli.time, "sleep", lambda _seconds: None)
        monkeypatch.setattr(subprocess, "Popen", lambda *_args, **_kwargs: process)
        monkeypatch.setattr(webbrowser, "open", lambda *_args, **_kwargs: True)
        monkeypatch.setattr(
            cli,
            "_wait_for_started_process",
            lambda started_process: waited_on.append(started_process) or 130,
        )

        result = main(["open"])

        assert result == 130
        assert waited_on == [process]
        assert capsys.readouterr().out.strip() == cli.DEFAULT_EDITOR_URL

    def test_terminate_process_stops_running_process(self):
        process = FakeProcess()

        cli._terminate_process(process)

        assert process.terminated is True
        assert process.wait_calls == 1


class FakeProcess:
    def __init__(self):
        self.wait_calls = 0
        self.terminated = False
        self.killed = False
        self.returncode = 0

    def poll(self) -> int | None:
        return None if not self.terminated and not self.killed else self.returncode

    def wait(self, timeout: float | None = None) -> int:
        self.wait_calls += 1
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = -15

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9
