"""Temporary diagnostic-build helper: explain why the installed engine did not start or stop.

Only installers built with -DiagnosticLogs include this program. The installer
runs it when the engine does not become ready or a stop command fails, and copies
its report into the Downloads diagnostic log. It collects:

- the tail of the engine's early startup log (Python tracebacks, exit codes),
- the text of any window the engine process is showing (start-up error dialogs),
- recent Windows "Application Error" records for the engine executable,
- a few environment facts that commonly block start-up.

With --watch it instead runs the engine start or stop command itself and reads
any window the engine shows while the command runs, because a start-up error
dialog blocks until the user closes it. --watch start returns 0 once the engine
answers, exits, or 20 seconds pass; --watch stop waits like NSIS ExecWait and
returns the stop command's own exit code.

It reads no meeting content, settings or model files and never fails the install
by itself: every section is best-effort, and the report mode always exits 0.
Remove it together with the diagnostic installer mode once the start-up failure
is understood.
"""

from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence

PRODUCT_DIR_NAME = "Barorok"
ENGINE_DIR_NAME = "LocalEngine"
STARTUP_LOG_NAME = "engine-startup.log"
FALLBACK_LOG_NAME = "Barorok-engine-startup.log"
TAIL_LINES = 40
MAX_LINE_CHARS = 400
MAX_WINDOW_TEXT_CHARS = 2000
EVENT_WINDOW_MILLISECONDS = 30 * 60 * 1000
MAX_EVENTS = 3
MAX_EVENT_LINES = 25
# NSIS strings hold 1024 characters; keep each record well below that with its prefix.
WRAP_CHARS = 400
LOCAL_ENGINE_PORT = 17863
WATCH_START_SECONDS = 20.0
WATCH_POLL_SECONDS = 0.25
WATCH_LAUNCH_FAILED_EXIT = 1
CONTROLLED_FOLDER_KEYS = (
    r"SOFTWARE\Microsoft\Windows Defender\Windows Defender Exploit Guard\Controlled Folder Access",
    r"SOFTWARE\Policies\Microsoft\Windows Defender\Windows Defender Exploit Guard\Controlled Folder Access",
)


def _clip(text: str, limit: int = MAX_LINE_CHARS) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _wrapped(prefix: str, text: str, *, limit: int = MAX_WINDOW_TEXT_CHARS) -> list[str]:
    text = " ".join(str(text).split())[:limit]
    if not text:
        return []
    chunks = [text[index:index + WRAP_CHARS] for index in range(0, len(text), WRAP_CHARS)]
    return [prefix + chunks[0]] + ["  | (계속) " + chunk for chunk in chunks[1:]]


def exit_code_text(code: int) -> str:
    unsigned = code & 0xFFFFFFFF
    return f"{code} (0x{unsigned:08X})"


def startup_log_paths(environ: Mapping[str, str]) -> list[Path]:
    paths: list[Path] = []
    local_app_data = environ.get("LOCALAPPDATA")
    if local_app_data:
        paths.append(Path(local_app_data) / PRODUCT_DIR_NAME / ENGINE_DIR_NAME / "logs" / STARTUP_LOG_NAME)
    temp = environ.get("TEMP") or environ.get("TMP")
    if temp:
        paths.append(Path(temp) / FALLBACK_LOG_NAME)
    return paths


def startup_log_section(paths: Iterable[Path]) -> list[str]:
    lines: list[str] = []
    for path in paths:
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            lines.append(f"[엔진 시작 로그] 없음 path={path}")
            continue
        except OSError as error:
            lines.append(f"[엔진 시작 로그] 읽기 실패 path={path} ({type(error).__name__})")
            continue
        text_lines = raw.decode("utf-8", errors="replace").splitlines()
        lines.append(f"[엔진 시작 로그] path={path} bytes={len(raw)} 마지막 {min(TAIL_LINES, len(text_lines))}줄")
        lines.extend("  | " + _clip(line) for line in text_lines[-TAIL_LINES:])
    return lines


def _windows_api():
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.EnumChildWindows.argtypes = [wintypes.HWND, callback_type, wintypes.LPARAM]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    return ctypes, wintypes, user32, kernel32, callback_type


def engine_window_texts(engine_name: str) -> list[str]:
    """Text of visible windows owned by processes whose executable has this file name."""
    if os.name != "nt":
        return []
    ctypes, wintypes, user32, kernel32, callback_type = _windows_api()
    process_query_limited_information = 0x1000
    image_cache: dict[int, str] = {}

    def image_of(pid: int) -> str:
        if pid not in image_cache:
            image = ""
            handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
            if handle:
                try:
                    size = wintypes.DWORD(32768)
                    buffer = ctypes.create_unicode_buffer(size.value)
                    if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                        image = buffer.value
                finally:
                    kernel32.CloseHandle(handle)
            image_cache[pid] = image
        return image_cache[pid]

    def text_of(hwnd) -> str:
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return ""
        buffer = ctypes.create_unicode_buffer(min(length, 32767) + 1)
        user32.GetWindowTextW(hwnd, buffer, len(buffer))
        return buffer.value

    def class_of(hwnd) -> str:
        buffer = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, buffer, len(buffer))
        return buffer.value

    found: list[str] = []
    target = engine_name.casefold()

    @callback_type
    def visit(hwnd, _lparam):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        image = image_of(pid.value)
        if not image or Path(image).name.casefold() != target or not user32.IsWindowVisible(hwnd):
            return True
        children: list[str] = []

        @callback_type
        def visit_child(child, _child_lparam):
            text = text_of(child)
            if text.strip():
                children.append(text)
            return True

        user32.EnumChildWindows(hwnd, visit_child, 0)
        found.append(f"[엔진 창] pid={pid.value} class={class_of(hwnd)} title={_clip(text_of(hwnd))} image={image}")
        found.extend(_wrapped("  | 내용: ", " / ".join(children)))
        return True

    user32.EnumWindows(visit, 0)
    return found


def _run_text(command: Sequence[str], runner: Callable[..., subprocess.CompletedProcess]) -> str:
    result = runner(
        list(command), capture_output=True, text=True, errors="replace", timeout=20,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return result.stdout or ""


def application_error_section(engine_name: str, runner: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> list[str]:
    query = (
        "*[System[(EventID=1000 or EventID=1001) and "
        f"TimeCreated[timediff(@SystemTime) <= {EVENT_WINDOW_MILLISECONDS}]]]"
    )
    try:
        output = _run_text(["wevtutil", "qe", "Application", f"/q:{query}", "/rd:true", "/c:30", "/f:text"], runner)
    except (OSError, subprocess.SubprocessError) as error:
        return [f"[Windows 오류 기록] 조회 실패 ({type(error).__name__})"]
    events = [block for block in output.split("Event[") if block.strip()]
    matching = [block for block in events if engine_name.casefold() in block.casefold()]
    if not matching:
        return [f"[Windows 오류 기록] 최근 30분 동안 {engine_name} 관련 기록 없음 (전체 {len(events)}건 확인)"]
    lines = [f"[Windows 오류 기록] {engine_name} 관련 {len(matching)}건 중 최근 {min(MAX_EVENTS, len(matching))}건"]
    for block in matching[:MAX_EVENTS]:
        block_lines = [_clip(line) for line in block.splitlines() if line.strip()]
        lines.extend("  | " + line for line in block_lines[:MAX_EVENT_LINES])
    return lines


def engine_process_section(engine_name: str, runner: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> list[str]:
    try:
        output = _run_text(["tasklist", "/FI", f"IMAGENAME eq {engine_name}", "/FO", "CSV", "/NH"], runner)
    except (OSError, subprocess.SubprocessError) as error:
        return [f"[엔진 프로세스] 조회 실패 ({type(error).__name__})"]
    rows = [line for line in output.splitlines() if engine_name.casefold() in line.casefold()]
    return [f"[엔진 프로세스] 실행 중 {len(rows)}개"] + ["  | " + _clip(row) for row in rows[:5]]


def _controlled_folder_access() -> str:
    try:
        import winreg
    except ImportError:
        return "unknown"
    values = []
    for key_path in CONTROLLED_FOLDER_KEYS:
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path) as key:
                value, _kind = winreg.QueryValueEx(key, "EnableControlledFolderAccess")
                values.append(f"{'policy' if 'Policies' in key_path else 'local'}={value}")
        except OSError:
            continue
    return ",".join(values) or "not-set"


def _data_root_status(data_root: Path) -> str:
    if not data_root.exists():
        return "missing"
    try:
        with tempfile.NamedTemporaryFile(dir=data_root, prefix=".write-probe-", delete=True):
            pass
        return "writable"
    except OSError as error:
        return f"not-writable ({type(error).__name__}: {_clip(str(error), 160)})"


def environment_section(engine_exe: str, environ: Mapping[str, str]) -> list[str]:
    local_app_data = environ.get("LOCALAPPDATA", "")
    data_root = Path(local_app_data) / PRODUCT_DIR_NAME / ENGINE_DIR_NAME if local_app_data else None
    return [
        "[설치 환경] "
        f"engine-path-ascii={engine_exe.isascii()} localappdata-ascii={local_app_data.isascii()} "
        f"controlled-folder-access={_controlled_folder_access()} "
        f"data-root={_data_root_status(data_root) if data_root else 'unknown'}",
    ]


def _section(name: str, collect: Callable[[], list[str]]) -> list[str]:
    try:
        return collect()
    except Exception as error:  # A report section must never stop the installer.
        return [f"[{name}] 수집 실패 ({type(error).__name__}: {_clip(str(error), 160)})"]


def build_report(
    stage: str,
    engine_exe: str,
    environ: Mapping[str, str],
    *,
    window_reader: Callable[[str], list[str]] = engine_window_texts,
    runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
) -> list[str]:
    engine_name = Path(engine_exe).name
    lines = [f"[엔진 보고서 시작] stage={_clip(stage, 80)} engine={engine_exe}"]
    lines += _section("엔진 시작 로그", lambda: startup_log_section(startup_log_paths(environ)))
    lines += _section("엔진 창", lambda: window_reader(engine_name) or ["[엔진 창] 엔진이 띄운 창 없음"])
    lines += _section("엔진 프로세스", lambda: engine_process_section(engine_name, runner))
    lines += _section("Windows 오류 기록", lambda: application_error_section(engine_name, runner))
    lines += _section("설치 환경", lambda: environment_section(engine_exe, environ))
    lines.append("[엔진 보고서 끝]")
    return lines


def _engine_port_ready() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", LOCAL_ENGINE_PORT), timeout=0.2):
            return True
    except OSError:
        return False


def watch_engine(
    command: Sequence[str],
    *,
    wait_until_exit: bool,
    window_reader: Callable[[str], list[str]] = engine_window_texts,
    popen: Callable[..., subprocess.Popen] = subprocess.Popen,
    port_ready: Callable[[], bool] = _engine_port_ready,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    start_seconds: float = WATCH_START_SECONDS,
) -> tuple[int | None, list[str]]:
    """Run an engine command and collect the windows it shows while it runs.

    A start-up error dialog blocks the process until the user closes it, so its
    text is read while it is open. A started engine keeps running after this
    program exits; a stop command is waited for like NSIS ExecWait.
    """
    engine_name = Path(command[0]).name
    label = " ".join(command[1:]) or "(start)"
    lines = [f"[엔진 실행 관찰] command={label} engine={command[0]}"]
    # Another process already answering on the port says nothing about this engine.
    port_busy_before = not wait_until_exit and port_ready()
    if port_busy_before:
        lines.append(f"[엔진 실행 관찰] 시작 전부터 {LOCAL_ENGINE_PORT} 포트가 응답함, 종료나 시간 제한까지 관찰")
    try:
        process = popen(
            list(command), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            close_fds=True, creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
    except OSError as error:
        lines.append(f"[엔진 실행 관찰] 실행 실패 ({type(error).__name__}: {_clip(str(error), 160)})")
        return None, lines
    seen: set[str] = set()
    started = clock()
    code: int | None = None
    result = ""
    while True:
        try:
            for line in window_reader(engine_name):
                if line not in seen:
                    seen.add(line)
                    lines.append(line)
        except Exception as error:  # Watching must never change what the command does.
            marker = f"[엔진 창] 수집 실패 ({type(error).__name__})"
            if marker not in seen:
                seen.add(marker)
                lines.append(marker)
        code = process.poll()
        if code is not None:
            result = f"exited code={exit_code_text(code)}"
            break
        elapsed = clock() - started
        if not wait_until_exit and not port_busy_before and port_ready():
            result = f"ready after {elapsed:.1f}s"
            break
        if not wait_until_exit and elapsed >= start_seconds:
            result = f"still starting after {start_seconds:.0f}s"
            break
        sleep(WATCH_POLL_SECONDS)
    lines.append(f"[엔진 실행 관찰] 결과 {result} windows={len([line for line in seen if line.startswith('[엔진 창] pid=')])}")
    return code, lines


def _signed_exit(code: int) -> int:
    """Pass a Windows exit code (e.g. 0xC0000135) through sys.exit unchanged."""
    code &= 0xFFFFFFFF
    return code - (1 << 32) if code >= (1 << 31) else code


def write_report(path: Path, lines: Sequence[str]) -> None:
    # NSIS reads this with FileReadUTF16LE (no byte-order mark), one line per diagnostic record.
    path.write_bytes(("\r\n".join(lines) + "\r\n").encode("utf-16-le"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Barorok diagnostic installer engine report")
    parser.add_argument("--stage", required=True)
    parser.add_argument("--engine-exe", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--watch", choices=("start", "stop"))
    raw_arguments = list(sys.argv[1:] if argv is None else argv)
    try:
        args = parser.parse_args(raw_arguments)
    except SystemExit:
        # A stop command that never ran must not look like a successful stop.
        return WATCH_LAUNCH_FAILED_EXIT if "--watch" in raw_arguments else 0
    if args.watch:
        stop = args.watch == "stop"
        command = [args.engine_exe, "--stop"] if stop else [args.engine_exe]
        try:
            code, lines = watch_engine(command, wait_until_exit=stop)
        except Exception as error:
            code, lines = None, [f"[엔진 실행 관찰] 실패 ({type(error).__name__}: {_clip(str(error), 160)})"]
        try:
            write_report(Path(args.output), [f"[엔진 실행 관찰 시작] stage={_clip(args.stage, 80)}", *lines])
        except OSError:
            pass
        if not stop:
            return 0
        return WATCH_LAUNCH_FAILED_EXIT if code is None else _signed_exit(code)
    try:
        lines = build_report(args.stage, args.engine_exe, os.environ)
    except Exception as error:
        lines = [f"[엔진 보고서] 작성 실패 ({type(error).__name__}: {_clip(str(error), 160)})"]
    try:
        write_report(Path(args.output), lines)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
