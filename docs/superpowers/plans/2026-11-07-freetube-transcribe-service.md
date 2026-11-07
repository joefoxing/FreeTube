# FreeTube Transcribe — Service Implementation Plan (Phase A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tailnet-hosted transcription service that turns `{videoId, startSeconds, endSeconds}` into timestamped transcript segments, by fetching only that audio window with yt-dlp and running faster-whisper on CPU.

**Architecture:** A single FastAPI process holding one inference worker. A job is queued, fetched with `yt-dlp --download-sections`, trimmed to the exact window and downmixed with ffmpeg, transcribed with a lazily-loaded faster-whisper model, and returned as segments with absolute video timestamps. Job state lives in memory; one worker at a time, because whisper is configured for half the host's cores.

**Tech Stack:** Python 3.13 managed with `uv`, FastAPI + uvicorn, faster-whisper 1.2.1 (ctranslate2 int8, CPU), PyAV pinned 18.0.0, yt-dlp pinned as a project dependency (invoked via `-m yt_dlp`), system ffmpeg 7.1.5, pytest + httpx for tests.

**Spec:** `docs/superpowers/specs/2026-11-07-freetube-transcribe-design.md` (FreeTube checkout, branch `freetube-transcribe`)

## Global Constraints

- Project directory: `/home/joefox/developer/freetube-stt` — never under `/` (the host's root filesystem is small by policy).
- Python pinned to `>=3.13,<3.14`; dependencies pinned exactly: `faster-whisper==1.2.1`, `av==18.0.0`, `yt-dlp==2026.10.26`. `av>=19` breaks faster-whisper (`av.open() got an unexpected keyword argument 'metadata_errors'`) — do not unpin.
- yt-dlp MUST be invoked with a JS runtime: `--js-runtimes node`. Without it yt-dlp exposes only m3u8-bound formats and no audio itag is selectable ("Requested format is not available").
- yt-dlp format selector: `bestaudio[abr<=80]/bestaudio` — a hardcoded itag fails on videos whose itags carry language suffixes (e.g. `251-8`).
- Window semantics: segments returned carry **absolute video seconds** (`start`/`end` already offset by the requested `startSeconds`), because yt-dlp cuts are exact at the START of a section but overshoot at the END by up to ~10 s (segment-aligned); the service trims with ffmpeg.
- Auth: `Authorization: Bearer <token>` on every route except `/health`, compared with `hmac.compare_digest`.
- Bind tailnet-only: default `FT_TRANSCRIBE_HOST=100.77.173.63`, `FT_TRANSCRIBE_PORT=9099`.
- All temperatures of the CPU are shared: one worker, `--threads 4`.
- Model cache lives in `~/.cache/huggingface` (under `/home`), model default `base`.

---

### Task A1: Project skeleton, config, and authenticated `/health`

**Files:**
- Create: `/home/joefox/developer/freetube-stt/pyproject.toml`
- Create: `/home/joefox/developer/freetube-stt/app/__init__.py` (empty)
- Create: `/home/joefox/developer/freetube-stt/app/config.py`
- Create: `/home/joefox/developer/freetube-stt/app/security.py`
- Create: `/home/joefox/developer/freetube-stt/app/main.py`
- Test: `/home/joefox/developer/freetube-stt/tests/test_config.py`
- Test: `/home/joefox/developer/freetube-stt/tests/test_health_auth.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config` dataclass with fields `token, host, port, whisper_model, whisper_threads, max_window_seconds, job_retention_seconds, queue_depth, work_dir, ytdlp_js_runtime`; `load_config(env: Mapping[str, str] = os.environ) -> Config`; `require_token(config) -> Callable` (FastAPI dependency); `create_app(config: Config | None = None) -> FastAPI`.

- [ ] **Step 1: Create the project and pin dependencies**

```bash
cd /home/joefox/developer/freetube-stt
cat > pyproject.toml <<'TOML'
[project]
name = "freetube-transcribe"
version = "0.1.0"
description = "Fetches a time window of a video's audio and transcribes it on CPU"
requires-python = ">=3.13,<3.14"
dependencies = [
  "fastapi>=0.115",
  "uvicorn>=0.34",
  "pydantic>=2.9",
  "faster-whisper==1.2.1",
  "av==18.0.0",
  "yt-dlp==2026.10.26",
]

[dependency-groups]
dev = ["pytest>=8.3", "httpx>=0.28"]

[tool.pytest.ini_options]
markers = ["network: hits YouTube and/or downloads a whisper model"]
addopts = "-m 'not network'"
TOML

uv venv --python 3.13 .venv
uv sync
uv run python -c "import faster_whisper, av, yt_dlp; print('deps ok', av.__version__)"
```

Expected: `deps ok 18.0.0`

- [ ] **Step 2: Write the failing config test**

```python
# tests/test_config.py
import pytest

from app.config import load_config


def test_missing_token_is_fatal():
    with pytest.raises(ValueError, match="FT_TRANSCRIBE_TOKEN"):
        load_config(env={})


def test_defaults_and_overrides():
    config = load_config(env={
        "FT_TRANSCRIBE_TOKEN": "secret",
        "FT_TRANSCRIBE_PORT": "9200",
        "FT_WHISPER_MODEL": "small",
    })

    assert config.token == "secret"
    assert config.port == 9200
    assert config.whisper_model == "small"
    assert config.host == "100.77.173.63"
    assert config.whisper_threads == 4
    assert config.max_window_seconds == 600
    assert config.ytdlp_js_runtime == "node"
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd /home/joefox/developer/freetube-stt && uv run pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.config'`

- [ ] **Step 4: Implement config and security**

```python
# app/config.py
import os
from dataclasses import dataclass
from typing import Mapping


@dataclass(frozen=True)
class Config:
    token: str
    host: str
    port: int
    whisper_model: str
    whisper_threads: int
    max_window_seconds: int
    job_retention_seconds: int
    queue_depth: int
    work_dir: str
    ytdlp_js_runtime: str


def load_config(env: Mapping[str, str] | None = None) -> Config:
    env = os.environ if env is None else env

    token = env.get("FT_TRANSCRIBE_TOKEN", "")
    if not token:
        raise ValueError("FT_TRANSCRIBE_TOKEN is required")

    return Config(
        token=token,
        host=env.get("FT_TRANSCRIBE_HOST", "100.77.173.63"),
        port=int(env.get("FT_TRANSCRIBE_PORT", 9099)),
        whisper_model=env.get("FT_WHISPER_MODEL", "base"),
        whisper_threads=int(env.get("FT_WHISPER_THREADS", 4)),
        max_window_seconds=int(env.get("FT_MAX_WINDOW_SECONDS", 600)),
        job_retention_seconds=int(env.get("FT_JOB_RETENTION_SECONDS", 600)),
        queue_depth=int(env.get("FT_QUEUE_DEPTH", 4)),
        work_dir=env.get("FT_WORK_DIR", "/tmp/freetube-transcribe"),
        ytdlp_js_runtime=env.get("FT_YTDLP_JS_RUNTIME", "node"),
    )
```

```python
# app/security.py
import hmac

from fastapi import Header, HTTPException

from app.config import Config


def require_token(config: Config):
    async def dependency(authorization: str | None = Header(default=None)):
        expected = f"Bearer {config.token}"
        if authorization is None or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail={"code": "E_UNAUTHORIZED", "message": "invalid or missing token"})

    return dependency
```

- [ ] **Step 5: Write the failing health/auth test**

```python
# tests/test_health_auth.py
from fastapi.testclient import TestClient

from app.config import load_config
from app.main import create_app

CONFIG = load_config(env={"FT_TRANSCRIBE_TOKEN": "t0ken"})


def test_health_needs_no_auth():
    client = TestClient(create_app(CONFIG))

    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["whisperModel"] == "base"
    assert "ytdlpVersion" in body


def test_jobs_route_rejects_missing_and_wrong_token():
    client = TestClient(create_app(CONFIG))

    assert client.post("/jobs", json={}).status_code == 401
    assert client.post("/jobs", json={}, headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.post("/jobs", json={}, headers={"Authorization": "Bearer t0ken"}).status_code == 422
```

- [ ] **Step 6: Run it to verify it fails**

Run: `uv run pytest tests/test_health_auth.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.main'`

- [ ] **Step 7: Implement the app shell**

```python
# app/main.py
import importlib.metadata

from fastapi import Depends, FastAPI

from app.config import Config, load_config
from app.security import require_token


def ytdlp_version() -> str:
    try:
        return importlib.metadata.version("yt-dlp")
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def create_app(config: Config | None = None) -> FastAPI:
    config = config or load_config()
    app = FastAPI(title="freetube-transcribe")
    auth = require_token(config)

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "ytdlpVersion": ytdlp_version(),
            "whisperModel": config.whisper_model,
            "modelLoaded": False,
            "queueDepth": 0,
        }

    @app.post("/jobs", dependencies=[Depends(auth)])
    async def create_job():
        # replaced in Task A4 with request validation + the real job store
        return {}

    return app


app = create_app()
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `uv run pytest tests/test_config.py tests/test_health_auth.py -v`
Expected: PASS (4 passed)

- [ ] **Step 9: Commit**

```bash
cd /home/joefox/developer/freetube-stt
git init -q && git add pyproject.toml uv.lock app tests .python-version 2>/dev/null
git commit -m "feat: transcribe service skeleton, config, and authenticated health route"
```

---

### Task A2: Command builders for yt-dlp and ffmpeg (pure, no I/O)

**Files:**
- Create: `app/media.py`
- Test: `tests/test_media.py`

**Interfaces:**
- Consumes: `Config`.
- Produces: `build_ytdlp_command(config, video_id, start_seconds, end_seconds, out_template) -> list[str]`; `build_ffmpeg_command(slice_path, wav_path, duration_seconds) -> list[str]`; `MediaError(Exception)` carrying `code` and `message`.

- [ ] **Step 1: Write the failing builder test**

```python
# tests/test_media.py
from app.config import load_config
from app.media import build_ffmpeg_command, build_ytdlp_command

CONFIG = load_config(env={"FT_TRANSCRIBE_TOKEN": "t"})


def test_ytdlp_command_uses_js_runtime_and_section_selector():
    cmd = build_ytdlp_command(CONFIG, "aircAruvnKk", 60, 300, "/tmp/x/%(id)s.%(ext)s")

    assert cmd[0].endswith("/yt-dlp") or cmd[1:3] == ["-m", "yt_dlp"]
    assert "--js-runtimes" in cmd and cmd[cmd.index("--js-runtimes") + 1] == "node"
    assert "--download-sections" in cmd
    assert cmd[cmd.index("--download-sections") + 1] == "*60-300"
    assert cmd[cmd.index("-f") + 1] == "bestaudio[abr<=80]/bestaudio"
    assert cmd[-1] == "https://www.youtube.com/watch?v=aircAruvnKk"


def test_ffmpeg_command_trims_to_exact_duration_and_downmixes():
    cmd = build_ffmpeg_command("/tmp/x/slice.webm", "/tmp/x/audio.wav", 240)

    assert cmd[0] == "ffmpeg"
    assert cmd[cmd.index("-t") + 1] == "240"
    assert cmd[cmd.index("-ac") + 1] == "1"
    assert cmd[cmd.index("-ar") + 1] == "16000"
    assert cmd[-1] == "/tmp/x/audio.wav"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_media.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.media'`

- [ ] **Step 3: Implement the builders and the stage runners**

```python
# app/media.py
import asyncio
import shutil
import sys
from pathlib import Path

from app.config import Config


class MediaError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def build_ytdlp_command(config: Config, video_id: str, start_seconds: int, end_seconds: int, out_template: str) -> list[str]:
    return [
        sys.executable, "-m", "yt_dlp",
        "--js-runtimes", config.ytdlp_js_runtime,
        "--no-playlist",
        "--no-progress",
        "--no-warnings",
        "-f", "bestaudio[abr<=80]/bestaudio",
        "--download-sections", f"*{start_seconds}-{end_seconds}",
        "-o", out_template,
        f"https://www.youtube.com/watch?v={video_id}",
    ]


def build_ffmpeg_command(slice_path: str, wav_path: str, duration_seconds: int) -> list[str]:
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-i", slice_path,
        "-t", str(duration_seconds),
        "-ac", "1",
        "-ar", "16000",
        "-f", "wav", "-y",
        wav_path,
    ]


async def _run(cmd: list[str], timeout: float, code: str) -> None:
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        _, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        process.kill()
        raise MediaError(code, f"timed out after {timeout:.0f}s")

    if process.returncode != 0:
        tail = stderr.decode(errors="replace").strip().splitlines()[-3:]
        raise MediaError(code, " | ".join(tail) or f"exit {process.returncode}")


async def fetch_section(config: Config, video_id: str, start_seconds: int, end_seconds: int, work_dir: Path) -> Path:
    work_dir.mkdir(parents=True, exist_ok=True)
    template = str(work_dir / "%(id)s.%(ext)s")

    await _run(
        build_ytdlp_command(config, video_id, start_seconds, end_seconds, template),
        timeout=120,
        code="E_FETCH_FAILED",
    )

    produced = sorted(p for p in work_dir.iterdir() if p.name.startswith(video_id) and not p.name.endswith(".part"))
    if not produced:
        raise MediaError("E_FETCH_FAILED", "yt-dlp produced no file")

    return produced[0]


async def decode_slice(slice_path: Path, wav_path: Path, duration_seconds: int) -> Path:
    if shutil.which("ffmpeg") is None:
        raise MediaError("E_DECODE_FAILED", "ffmpeg not found on PATH")

    await _run(build_ffmpeg_command(str(slice_path), str(wav_path), duration_seconds), timeout=120, code="E_DECODE_FAILED")

    if not wav_path.exists() or wav_path.stat().st_size == 0:
        raise MediaError("E_DECODE_FAILED", "ffmpeg produced no audio")

    return wav_path
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run pytest tests/test_media.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Add a real-ffmpeg round trip test (no network)**

```python
# tests/test_media_ffmpeg.py
import shutil
import subprocess

import pytest

from app.media import decode_slice

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required")


@pytest.mark.asyncio
async def test_decode_slice_trims_to_requested_duration(tmp_path):
    source = tmp_path / "tone.webm"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
        "-i", "sine=frequency=440:duration=30", "-c:a", "libopus", str(source),
    ], check=True)

    wav = await decode_slice(source, tmp_path / "audio.wav", 10)

    probe = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(wav),
    ], check=True, capture_output=True, text=True)

    assert 9.5 < float(probe.stdout.strip()) < 10.5
```

Note: add `asyncio_mode = "auto"` to `[tool.pytest.ini_options]` in `pyproject.toml` and install `pytest-asyncio` in the dev group (`uv add --dev pytest-asyncio`) before running. This makes every later `async def test_` work without decorators.

- [ ] **Step 6: Run it to verify it passes**

Run: `uv run pytest tests/test_media_ffmpeg.py -v`
Expected: PASS (1 passed) — a 30 s tone trimmed to a ~10 s wav.

- [ ] **Step 7: Commit**

```bash
git add app/media.py tests/test_media.py tests/test_media_ffmpeg.py pyproject.toml uv.lock
git commit -m "feat: yt-dlp and ffmpeg command builders with real-ffmpeg trim test"
```

---

### Task A3: Whisper transcriber with absolute-timestamp offsetting

**Files:**
- Create: `app/stt.py`
- Test: `tests/test_stt.py` (offline, fake model) and `tests/test_stt_integration.py` (`network` marker)

**Interfaces:**
- Consumes: `Config`.
- Produces: `Segment` dataclass `{start: float, end: float, text: str}`; `TranscriptError(Exception)` with `code`/`message`; `Transcriber(config)` with `is_loaded` property and `transcribe(wav_path: Path, offset_seconds: float) -> tuple[list[Segment], str]` returning `(segments, language)`.

- [ ] **Step 1: Write the failing offsetting test with a fake model**

```python
# tests/test_stt.py
from pathlib import Path

from app.config import load_config
from app.stt import Transcriber

CONFIG = load_config(env={"FT_TRANSCRIBE_TOKEN": "t"})


class FakeSegment:
    def __init__(self, start, end, text):
        self.start = start
        self.end = end
        self.text = text


class FakeInfo:
    language = "en"
    duration = 240.0


class FakeModel:
    def transcribe(self, path, **kwargs):
        return [FakeSegment(0.0, 6.5, " hello "), FakeSegment(6.5, 12.0, "world")], FakeInfo()


def test_segments_are_offset_to_absolute_video_time(monkeypatch, tmp_path):
    transcriber = Transcriber(CONFIG, model_factory=lambda: FakeModel())

    segments, language = transcriber.transcribe(tmp_path / "audio.wav", offset_seconds=60.0)

    assert language == "en"
    assert [(s.start, s.end, s.text) for s in segments] == [
        (60.0, 66.5, "hello"),
        (66.5, 72.0, "world"),
    ]


def test_model_is_loaded_lazily(monkeypatch, tmp_path):
    calls = []

    def factory():
        calls.append(1)
        return FakeModel()

    transcriber = Transcriber(CONFIG, model_factory=factory)

    assert transcriber.is_loaded is False
    transcriber.transcribe(tmp_path / "audio.wav", offset_seconds=0)
    assert calls == [1]
    transcriber.transcribe(tmp_path / "audio.wav", offset_seconds=0)
    assert calls == [1]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_stt.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.stt'`

- [ ] **Step 3: Implement the transcriber**

```python
# app/stt.py
from dataclasses import dataclass
from pathlib import Path

from app.config import Config


class TranscriptError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class Segment:
    start: float
    end: float
    text: str


def _default_model_factory(config: Config):
    def factory():
        from faster_whisper import WhisperModel

        return WhisperModel(
            config.whisper_model,
            device="cpu",
            compute_type="int8",
            cpu_threads=config.whisper_threads,
        )

    return factory


class Transcriber:
    def __init__(self, config: Config, model_factory=None):
        self._config = config
        self._model_factory = model_factory or _default_model_factory(config)
        self._model = None

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    def ensure_loaded(self) -> None:
        if self._model is None:
            try:
                self._model = self._model_factory()
            except Exception as error:  # model download / ctranslate2 load failures
                raise TranscriptError("E_MODEL_FAILED", str(error)) from error

    def transcribe(self, wav_path: Path, offset_seconds: float) -> tuple[list[Segment], str]:
        self.ensure_loaded()

        try:
            raw_segments, info = self._model.transcribe(str(wav_path), vad_filter=True, beam_size=1)
            segments = [
                Segment(start=offset_seconds + s.start, end=offset_seconds + s.end, text=s.text.strip())
                for s in raw_segments
            ]
        except Exception as error:
            raise TranscriptError("E_TRANSCRIBE_FAILED", str(error)) from error

        return [s for s in segments if s.text], info.language
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run pytest tests/test_stt.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Add the opt-in network integration test**

```python
# tests/test_stt_integration.py
import pytest

from app.config import load_config
from app.media import decode_slice, fetch_section
from app.stt import Transcriber

pytestmark = pytest.mark.network


async def test_real_window_transcribes_the_known_opening_line(tmp_path):
    config = load_config(env={"FT_TRANSCRIBE_TOKEN": "t"})

    slice_path = await fetch_section(config, "jNQXAC9IVRw", 0, 20, tmp_path)
    wav = await decode_slice(slice_path, tmp_path / "audio.wav", 19)

    segments, language = Transcriber(config).transcribe(wav, offset_seconds=0)

    text = " ".join(s.text for s in segments).lower()
    assert language == "en"
    assert "elephant" in text
    assert all(0 <= s.start <= 25 for s in segments)
```

- [ ] **Step 6: Run integration explicitly (downloads the base model, ~150 MB, into ~/.cache/huggingface)**

Run: `uv run pytest tests/test_stt_integration.py -v -m network`
Expected: PASS (1 passed) — transcript contains "elephant".

- [ ] **Step 7: Commit**

```bash
git add app/stt.py tests/test_stt.py tests/test_stt_integration.py
git commit -m "feat: whisper transcriber with absolute-timestamp offsetting"
```

---

### Task A4: Job store, single worker, and the HTTP contract

**Files:**
- Create: `app/models.py`
- Create: `app/jobs.py`
- Modify: `app/main.py` (replace the placeholder `/jobs` route; add `GET /jobs/{job_id}`, `POST /jobs/{job_id}/cancel`, real `/health` body)
- Test: `tests/test_jobs.py`
- Test: `tests/test_api.py`

**Interfaces:**
- Consumes: `Config`, `Segment`, `MediaError`, `TranscriptError`.
- Produces: `JobRequest` pydantic model (JSON aliases `videoId`, `startSeconds`, `endSeconds`, `language`); `JobView` pydantic model (`jobId`, `state`, `stage`, `progress`, `segments`, `language`, `error`, `timings`); `JobStore(config, pipeline)` with `submit(request) -> Job` (raises `WindowInvalid`, `QueueFull`), `get(job_id)`, `cancel(job_id)`, `queue_depth`, `start()`, `stop()`; `Pipeline` protocol with `run(job, reporter) -> PipelineResult` where `PipelineResult` is `(segments, language, timings)`. `reporter(stage: str, progress: float)`.

- [ ] **Step 1: Write the failing job store test**

```python
# tests/test_jobs.py
import pytest

from app.config import load_config
from app.jobs import JobStore, QueueFull, WindowInvalid
from app.stt import Segment

CONFIG = load_config(env={"FT_TRANSCRIBE_TOKEN": "t", "FT_QUEUE_DEPTH": "1"})


class FakePipeline:
    def __init__(self):
        self.calls = []

    def run(self, job, reporter):
        self.calls.append(job)
        reporter("fetching", 0.5)
        reporter("transcribing", 0.9)
        segments = [Segment(start=job.start_seconds, end=job.start_seconds + 1, text="hi")]
        return segments, "en", {"fetchMs": 1, "decodeMs": 1, "transcribeMs": 1}


def drain(store):
    """Run queued jobs synchronously in this thread for a deterministic test."""
    while not store._queue.empty():
        store._process_one()


def test_window_validation():
    store = JobStore(CONFIG, FakePipeline())

    with pytest.raises(WindowInvalid):
        store.submit(video_id="x", start_seconds=100, end_seconds=100)
    with pytest.raises(WindowInvalid):
        store.submit(video_id="x", start_seconds=0, end_seconds=9999)


def test_job_lifecycle_and_result_shape():
    pipeline = FakePipeline()
    store = JobStore(CONFIG, pipeline)

    job = store.submit(video_id="aircAruvnKk", start_seconds=60, end_seconds=300)
    assert job.view().state == "queued"

    drain(store)

    view = store.get(job.id).view()
    assert view.state == "done"
    assert view.stage == "transcribing"
    assert view.progress == 1.0
    assert view.segments[0].text == "hi"
    assert view.language == "en"
    assert view.error is None


def test_queue_depth_limit():
    store = JobStore(CONFIG, FakePipeline())

    store.submit(video_id="a", start_seconds=0, end_seconds=30)

    with pytest.raises(QueueFull):
        store.submit(video_id="b", start_seconds=0, end_seconds=30)


def test_pipeline_failure_becomes_an_error_view():
    class Failing(FakePipeline):
        def run(self, job, reporter):
            from app.media import MediaError
            raise MediaError("E_FETCH_FAILED", "boom")

    store = JobStore(CONFIG, Failing())
    job = store.submit(video_id="a", start_seconds=0, end_seconds=30)

    drain(store)

    view = store.get(job.id).view()
    assert view.state == "error"
    assert view.error.code == "E_FETCH_FAILED"
    assert view.segments == []


def test_cancel_marks_the_job():
    store = JobStore(CONFIG, FakePipeline())
    job = store.submit(video_id="a", start_seconds=0, end_seconds=30)

    store.cancel(job.id)

    assert store.get(job.id).view().state == "cancelled"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_jobs.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.jobs'`

- [ ] **Step 3: Implement the models and job store**

```python
# app/models.py
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class JobRequest(CamelModel):
    video_id: str
    start_seconds: float
    end_seconds: float
    language: str | None = None


class SegmentView(CamelModel):
    start: float
    end: float
    text: str


class ErrorView(CamelModel):
    code: str
    message: str


class TimingsView(CamelModel):
    fetch_ms: int = 0
    decode_ms: int = 0
    transcribe_ms: int = 0


class JobView(CamelModel):
    job_id: str
    state: str
    stage: str
    progress: float
    segments: list[SegmentView] = Field(default_factory=list)
    language: str | None = None
    error: ErrorView | None = None
    timings: TimingsView = Field(default_factory=TimingsView)
```

```python
# app/jobs.py
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field

from app.config import Config
from app.models import ErrorView, JobView, SegmentView, TimingsView


class WindowInvalid(Exception):
    pass


class QueueFull(Exception):
    pass


class UnknownJob(Exception):
    pass


@dataclass
class Job:
    id: str
    video_id: str
    start_seconds: float
    end_seconds: float
    language: str | None = None
    state: str = "queued"
    stage: str = "queued"
    progress: float = 0.0
    segments: list = field(default_factory=list)
    detected_language: str | None = None
    error: ErrorView | None = None
    timings: dict = field(default_factory=dict)
    cancel_event: threading.Event = field(default_factory=threading.Event)
    created_at: float = field(default_factory=time.time)

    @property
    def duration_seconds(self) -> int:
        return int(round(self.end_seconds - self.start_seconds))

    def view(self) -> JobView:
        return JobView(
            job_id=self.id,
            state=self.state,
            stage=self.stage,
            progress=self.progress,
            segments=[SegmentView(start=s.start, end=s.end, text=s.text) for s in self.segments],
            language=self.detected_language,
            error=self.error,
            timings=TimingsView(**self.timings),
        )


class JobStore:
    def __init__(self, config: Config, pipeline):
        self._config = config
        self._pipeline = pipeline
        self._jobs: dict[str, Job] = {}
        self._queue: queue.Queue[Job] = queue.Queue()
        self._lock = threading.Lock()
        self._worker: threading.Thread | None = None
        self._stopping = threading.Event()

    # --- lifecycle -------------------------------------------------------
    def start(self):
        self._worker = threading.Thread(target=self._run_worker, daemon=True)
        self._worker.start()

    def stop(self):
        self._stopping.set()
        self._queue.put(None)  # type: ignore[arg-type]

    # --- public API ------------------------------------------------------
    @property
    def queue_depth(self) -> int:
        return self._queue.qsize()

    def submit(self, video_id: str, start_seconds: float, end_seconds: float, language: str | None = None) -> Job:
        if end_seconds <= start_seconds:
            raise WindowInvalid("endSeconds must be greater than startSeconds")
        if end_seconds - start_seconds > self._config.max_window_seconds:
            raise WindowInvalid(f"window exceeds {self._config.max_window_seconds}s")

        with self._lock:
            self._evict_expired()
            if self._queue.qsize() >= self._config.queue_depth:
                raise QueueFull("too many queued jobs")

            job = Job(
                id=uuid.uuid4().hex,
                video_id=video_id,
                start_seconds=float(start_seconds),
                end_seconds=float(end_seconds),
                language=language,
            )
            self._jobs[job.id] = job

        self._queue.put(job)
        return job

    def get(self, job_id: str) -> Job:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise UnknownJob(job_id)
        return job

    def cancel(self, job_id: str) -> Job:
        job = self.get(job_id)
        job.cancel_event.set()
        if job.state == "queued":
            job.state = "cancelled"
        return job

    # --- internals -------------------------------------------------------
    def _evict_expired(self):
        cutoff = time.time() - self._config.job_retention_seconds
        for job_id in [j.id for j in self._jobs.values() if j.created_at < cutoff and j.state in {"done", "error", "cancelled"}]:
            self._jobs.pop(job_id, None)

    def _run_worker(self):
        while not self._stopping.is_set():
            job = self._queue.get()
            if job is None:
                break
            if job.state == "cancelled":
                continue
            self._process_one(job)

    def _process_one(self, job: Job | None = None):
        # used by both the worker thread and the synchronous test drain
        if job is None:
            job = self._queue.get()
        if job.state == "cancelled":
            return

        job.state = "running"
        started = {k: time.time() for k in ("fetch", "decode", "transcribe")}

        def reporter(stage: str, progress: float):
            job.stage = stage
            job.progress = progress

        try:
            segments, language, timings = self._pipeline.run(job, reporter)
        except Exception as error:
            if job.cancel_event.is_set():
                job.state = "cancelled"
                return
            job.state = "error"
            job.error = ErrorView(
                code=getattr(error, "code", "E_INTERNAL"),
                message=getattr(error, "message", str(error)),
            )
            return

        if job.cancel_event.is_set():
            job.state = "cancelled"
            return

        job.segments = segments
        job.detected_language = language
        job.timings = timings
        job.stage = "transcribing"
        job.progress = 1.0
        job.state = "done"
```

- [ ] **Step 4: Run the job store test**

Run: `uv run pytest tests/test_jobs.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Write the failing API test**

```python
# tests/test_api.py
from fastapi.testclient import TestClient

from app.config import load_config
from app.main import create_app

CONFIG = load_config(env={"FT_TRANSCRIBE_TOKEN": "t0ken"})
HEADERS = {"Authorization": "Bearer t0ken"}


class FakePipeline:
    def run(self, job, reporter):
        from app.stt import Segment
        return [Segment(start=job.start_seconds, end=job.start_seconds + 2, text="hello")], "en", {"fetchMs": 5}


def make_client():
    app = create_app(CONFIG, pipeline_factory=lambda config: FakePipeline(), autostart=False)
    return TestClient(app), app


def test_create_job_returns_201_and_camel_case_view():
    client, app = make_client()

    response = client.post("/jobs", json={"videoId": "abc123", "startSeconds": 60, "endSeconds": 300}, headers=HEADERS)

    assert response.status_code == 201
    body = response.json()
    assert body["state"] == "queued"
    assert body["startSeconds"] == 60

    app.state.job_store._process_one()

    status = client.get(f"/jobs/{body['jobId']}", headers=HEADERS).json()
    assert status["state"] == "done"
    assert status["segments"] == [{"start": 60.0, "end": 62.0, "text": "hello"}]


def test_invalid_window_is_422_and_unknown_job_is_404():
    client, _ = make_client()

    assert client.post("/jobs", json={"videoId": "a", "startSeconds": 10, "endSeconds": 10}, headers=HEADERS).status_code == 422
    assert client.get("/jobs/nope", headers=HEADERS).status_code == 404


def test_cancel_route():
    client, _ = make_client()
    job_id = client.post("/jobs", json={"videoId": "a", "startSeconds": 0, "endSeconds": 30}, headers=HEADERS).json()["jobId"]

    response = client.post(f"/jobs/{job_id}/cancel", headers=HEADERS)

    assert response.status_code == 200
    assert response.json()["state"] == "cancelled"
```

- [ ] **Step 6: Run it to verify it fails**

Run: `uv run pytest tests/test_api.py -v`
Expected: FAIL — `create_app() got an unexpected keyword argument 'pipeline_factory'`

- [ ] **Step 7: Wire the routes**

```python
# app/main.py  (replace create_app; keep ytdlp_version)
from fastapi import Depends, FastAPI, HTTPException, Request

from app.config import Config, load_config
from app.jobs import JobStore, QueueFull, UnknownJob, WindowInvalid
from app.models import JobRequest, JobView
from app.security import require_token


def create_app(config: Config | None = None, pipeline_factory=None, autostart: bool = True) -> FastAPI:
    config = config or load_config()
    app = FastAPI(title="freetube-transcribe")
    auth = require_token(config)

    if pipeline_factory is None:
        from app.pipeline import Pipeline

        pipeline_factory = lambda cfg: Pipeline(cfg)  # noqa: E731

    store = JobStore(config, pipeline_factory(config))
    app.state.job_store = store
    if autostart:
        store.start()

    @app.get("/health")
    async def health():
        transcriber = getattr(store._pipeline, "transcriber", None)
        return {
            "status": "ok",
            "ytdlpVersion": ytdlp_version(),
            "whisperModel": config.whisper_model,
            "modelLoaded": bool(transcriber and transcriber.is_loaded),
            "queueDepth": store.queue_depth,
        }

    @app.post("/jobs", status_code=201, response_model=JobView, dependencies=[Depends(auth)])
    async def create_job(request: JobRequest):
        try:
            job = store.submit(
                video_id=request.video_id,
                start_seconds=request.start_seconds,
                end_seconds=request.end_seconds,
                language=request.language,
            )
        except WindowInvalid as error:
            raise HTTPException(status_code=422, detail={"code": "E_WINDOW_INVALID", "message": str(error)})
        except QueueFull as error:
            raise HTTPException(status_code=409, detail={"code": "E_BUSY", "message": str(error)})

        return _with_window(job)

    @app.get("/jobs/{job_id}", response_model=JobView, dependencies=[Depends(auth)])
    async def get_job(job_id: str):
        try:
            return _with_window(store.get(job_id))
        except UnknownJob:
            raise HTTPException(status_code=404, detail={"code": "E_UNKNOWN_JOB", "message": job_id})

    @app.post("/jobs/{job_id}/cancel", response_model=JobView, dependencies=[Depends(auth)])
    async def cancel_job(job_id: str):
        try:
            return _with_window(store.cancel(job_id))
        except UnknownJob:
            raise HTTPException(status_code=404, detail={"code": "E_UNKNOWN_JOB", "message": job_id})

    @app.on_event("shutdown")
    async def shutdown():
        store.stop()

    return app


def _with_window(job) -> JobView:
    """The view must echo the requested window so the client can label the overlay."""
    view = job.view()
    return view
```

Note: `JobView` gains `start_seconds`/`end_seconds` fields for this echo — add them to `app/models.py` in this step:

```python
class JobView(CamelModel):
    job_id: str
    start_seconds: float
    end_seconds: float
    state: str
    stage: str
    progress: float
    segments: list[SegmentView] = Field(default_factory=list)
    language: str | None = None
    error: ErrorView | None = None
    timings: TimingsView = Field(default_factory=TimingsView)
```

and `Job.view()` passes `start_seconds=self.start_seconds, end_seconds=self.end_seconds`. Update `tests/test_jobs.py` expectations accordingly (it asserts `view().state` / `.segments` only, so no change needed).

- [ ] **Step 8: Run the API and job tests**

Run: `uv run pytest tests/test_jobs.py tests/test_api.py -v`
Expected: PASS (8 passed)

- [ ] **Step 9: Commit**

```bash
git add app/models.py app/jobs.py app/main.py tests/test_jobs.py tests/test_api.py
git commit -m "feat: job queue with single worker and the jobs HTTP contract"
```

---

### Task A5: The real pipeline (fetch → decode → transcribe)

**Files:**
- Create: `app/pipeline.py`
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: `Config`, `fetch_section`, `decode_slice`, `MediaError`, `Transcriber`, `TranscriptError`.
- Produces: `Pipeline(config)` exposing `transcriber` (for `/health`) and `run(job, reporter) -> tuple[list[Segment], str, dict]` with `timings` keys `fetchMs`, `decodeMs`, `transcribeMs`; `PipelineError`.

- [ ] **Step 1: Write the failing test with stubbed stages**

```python
# tests/test_pipeline.py
import pytest

from app.config import load_config
from app.jobs import Job
from app.pipeline import Pipeline
from app.stt import Segment

CONFIG = load_config(env={"FT_TRANSCRIBE_TOKEN": "t"})


class FakeTranscriber:
    is_loaded = True

    def __init__(self):
        self.offsets = []

    def transcribe(self, wav_path, offset_seconds):
        self.offsets.append(offset_seconds)
        return [Segment(start=offset_seconds + 0.5, end=offset_seconds + 1.5, text="word")], "en"


def test_pipeline_reports_stages_and_offsets_segments(tmp_path):
    stages = []

    pipeline = Pipeline(
        CONFIG,
        fetch=lambda *a, **k: tmp_path / "slice.webm",
        decode=lambda *a, **k: tmp_path / "audio.wav",
        transcriber=FakeTranscriber(),
    )

    job = Job(id="j1", video_id="v", start_seconds=60, end_seconds=300)
    segments, language, timings = pipeline.run(job, lambda stage, progress: stages.append((stage, progress)))

    assert [s[0] for s in stages] == ["fetching", "decoding", "transcribing"]
    assert segments[0].start == 60.5
    assert language == "en"
    assert set(timings) == {"fetchMs", "decodeMs", "transcribeMs"}


def test_cancellation_stops_before_transcribing(tmp_path):
    pipeline = Pipeline(
        CONFIG,
        fetch=lambda *a, **k: tmp_path / "slice.webm",
        decode=lambda *a, **k: tmp_path / "audio.wav",
        transcriber=FakeTranscriber(),
    )
    job = Job(id="j1", video_id="v", start_seconds=60, end_seconds=300)

    def reporter(stage, progress):
        if stage == "fetching":
            job.cancel_event.set()

    with pytest.raises(Exception, match="cancelled"):
        pipeline.run(job, reporter)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_pipeline.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.pipeline'`

- [ ] **Step 3: Implement the pipeline**

```python
# app/pipeline.py
import shutil
import time
from pathlib import Path

from app.config import Config
from app.media import MediaError, decode_slice, fetch_section
from app.stt import Transcriber


class Cancelled(Exception):
    pass


class Pipeline:
    def __init__(self, config: Config, fetch=None, decode=None, transcriber=None):
        self._config = config
        self._fetch = fetch or fetch_section
        self._decode = decode or decode_slice
        self.transcriber = transcriber or Transcriber(config)

    def run(self, job, reporter):
        work_dir = Path(self._config.work_dir) / job.id
        work_dir.mkdir(parents=True, exist_ok=True)

        try:
            reporter("fetching", 0.05)
            started = time.time()
            slice_path = self._fetch(self._config, job.video_id, int(job.start_seconds), int(job.end_seconds), work_dir)
            fetch_ms = int((time.time() - started) * 1000)
            self._check_cancel(job)

            reporter("decoding", 0.45)
            started = time.time()
            wav_path = self._decode(slice_path, work_dir / "audio.wav", job.duration_seconds)
            decode_ms = int((time.time() - started) * 1000)
            self._check_cancel(job)

            reporter("transcribing", 0.55)
            started = time.time()
            segments, language = self.transcriber.transcribe(wav_path, offset_seconds=job.start_seconds)
            transcribe_ms = int((time.time() - started) * 1000)

            return segments, language, {"fetchMs": fetch_ms, "decodeMs": decode_ms, "transcribeMs": transcribe_ms}
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    def _check_cancel(self, job):
        if job.cancel_event.is_set():
            raise Cancelled("cancelled")
```

Note: `Pipeline.run` may block (whisper is synchronous); it is only ever called from the single worker thread, which is why the store tolerates a blocking call.

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run pytest tests/test_pipeline.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Check for a stage-pollution bug (progress must be monotonic per stage)**

Add this case to `tests/test_pipeline.py` and make it pass by keeping the reporter contract as-is (0.05 → 0.45 → 0.55 → 1.0 from the store):

```python
def test_reported_progress_never_exceeds_one(tmp_path):
    pipeline = Pipeline(CONFIG, fetch=lambda *a, **k: tmp_path / "s.webm",
                        decode=lambda *a, **k: tmp_path / "a.wav", transcriber=FakeTranscriber())
    job = Job(id="j1", video_id="v", start_seconds=0, end_seconds=30)

    seen = []
    pipeline.run(job, lambda stage, progress: seen.append(progress))

    assert all(0.0 <= p <= 1.0 for p in seen)
```

- [ ] **Step 6: Run all offline tests**

Run: `uv run pytest -v`
Expected: PASS, no failures, no `network` tests collected.

- [ ] **Step 7: Commit**

```bash
git add app/pipeline.py tests/test_pipeline.py
git commit -m "feat: fetch/decode/transcribe pipeline with stage reporting and cancellation"
```

---

### Task A6: Run it for real, against the tailnet

**Files:**
- Create: `deploy/env.example`
- Create: `README.md`
- Create: `deploy/freetube-transcribe.service`

**Interfaces:**
- Consumes: everything above.
- Produces: a running service reachable at `http://100.77.173.63:9099` with a token in `/home/joefox/.config/freetube-transcribe/env`.

- [ ] **Step 1: Generate a token and an env file**

```bash
mkdir -p /home/joefox/.config/freetube-transcribe
TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
cat > /home/joefox/.config/freetube-transcribe/env <<EOF
FT_TRANSCRIBE_TOKEN=$TOKEN
FT_WHISPER_MODEL=base
FT_WHISPER_THREADS=4
FT_TRANSCRIBE_HOST=100.77.173.63
FT_TRANSCRIBE_PORT=9099
EOF
chmod 600 /home/joefox/.config/freetube-transcribe/env
echo "token: $TOKEN"   # record it; the app's settings need it
```

Copy the same file shape (with a placeholder value) to `deploy/env.example`.

- [ ] **Step 2: Start it manually and prove the real path end to end**

```bash
cd /home/joefox/developer/freetube-stt
set -a; . /home/joefox/.config/freetube-transcribe/env; set +a
uv run uvicorn app.main:app --host "$FT_TRANSCRIBE_HOST" --port "$FT_TRANSCRIBE_PORT" &
sleep 3
curl -s http://100.77.173.63:9099/health
```

Expected: `{"status":"ok","ytdlpVersion":"2026.10.26","whisperModel":"base","modelLoaded":false,"queueDepth":0}`

- [ ] **Step 3: Submit a real job and read the transcript**

```bash
TOKEN=$(grep FT_TRANSCRIBE_TOKEN /home/joefox/.config/freetube-transcribe/env | cut -d= -f2)
JOB=$(curl -s -X POST http://100.77.173.63:9099/jobs -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"videoId":"jNQXAC9IVRw","startSeconds":0,"endSeconds":20}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["jobId"])')
for i in $(seq 1 40); do sleep 2; curl -s "http://100.77.173.63:9099/jobs/$JOB" -H "Authorization: Bearer $TOKEN" > /tmp/job.json; state=$(python3 -c 'import json;print(json.load(open("/tmp/job.json"))["state"])'); [ "$state" != "running" ] && [ "$state" != "queued" ] && break; done
python3 -c 'import json; d=json.load(open("/tmp/job.json")); print(d["state"], d["language"], d["timings"]); [print(round(s["start"],1), round(s["end"],1), s["text"]) for s in d["segments"]]'
```

Expected: `done en {...}` and a transcript whose first line mentions the elephants — the exact line the probe produced in 3 s + ~2 s of transcription.

- [ ] **Step 4: Stop the manual run and install the unit**

```bash
kill %1 2>/dev/null
mkdir -p /home/joefox/.config/systemd/user
cat > /home/joefox/.config/systemd/user/freetube-transcribe.service <<'UNIT'
[Unit]
Description=FreeTube transcription service (yt-dlp + faster-whisper)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/joefox/developer/freetube-stt
EnvironmentFile=/home/joefox/.config/freetube-transcribe/env
ExecStart=/home/joefox/developer/freetube-stt/.venv/bin/python -m uvicorn app.main:app --host ${FT_TRANSCRIBE_HOST} --port ${FT_TRANSCRIBE_PORT}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now freetube-transcribe.service
sleep 3
systemctl --user status freetube-transcribe.service --no-pager | head -12
curl -s -o /dev/null -w 'health from tailnet -> %{http_code}\n' http://100.77.173.63:9099/health
```

Expected: unit `active (running)`, and `health from tailnet -> 200`.

- [ ] **Step 5: Write the README runbook**

Document, in `README.md`: the env file and its keys, `systemctl --user` commands, the yt-dlp upgrade procedure (`uv run yt-dlp --version`, bump the pin, `uv sync`, restart, re-run `uv run pytest -m network`), the PyAV pin warning, and the copy-paste curl commands from steps 2–3. Include the measured numbers from the spec (§3) so a future reader knows what "normal" looks like: ~8 s fetch and ~14x realtime transcription for a 240 s window.

- [ ] **Step 6: Commit**

```bash
git add README.md deploy/
git commit -m "feat: systemd user unit, env template, and operations runbook"
```

---

## Verification (Phase A complete when all hold)

- `uv run pytest -v` passes with no network calls; `uv run pytest -m network -v` passes when run deliberately.
- `curl http://100.77.173.63:9099/health` returns the pinned yt-dlp version and `modelLoaded: true` after the first job.
- A real job for `jNQXAC9IVRw` 0–20 returns `done` with segments mentioning the elephants, timestamps inside `[0, 20]`.
- `ss -ltnp | grep 9099` shows the bind on `100.77.173.63` only (not `0.0.0.0`), and a request without the bearer token gets 401.
- No process writes to `/`; the venv, model cache and work dir are all under `/home`.
