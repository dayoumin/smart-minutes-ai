"""Own a Windows subprocess tree without changing subprocess.Popen's interface."""

import ctypes
import os
import subprocess
import time
from ctypes import wintypes


_IS_WINDOWS = os.name == "nt"
_CREATE_SUSPENDED = 0x00000004
_KILL_ON_JOB_CLOSE = 0x00002000


class _BasicLimits(ctypes.Structure):
    _fields_ = [
        ("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
        ("flags", wintypes.DWORD), ("min_working_set", ctypes.c_size_t),
        ("max_working_set", ctypes.c_size_t), ("active_limit", wintypes.DWORD),
        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
        ("scheduling", wintypes.DWORD),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in (
        "read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes",
    )]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("basic", _BasicLimits), ("io", _IoCounters),
        ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
        ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t),
    ]


class _Accounting(ctypes.Structure):
    _fields_ = [
        ("user_time", ctypes.c_longlong), ("kernel_time", ctypes.c_longlong),
        ("period_user_time", ctypes.c_longlong), ("period_kernel_time", ctypes.c_longlong),
        ("page_faults", wintypes.DWORD), ("total", wintypes.DWORD),
        ("active", wintypes.DWORD), ("terminated", wintypes.DWORD),
    ]


class _ThreadEntry(ctypes.Structure):
    _fields_ = [
        ("size", wintypes.DWORD), ("usage", wintypes.DWORD),
        ("thread_id", wintypes.DWORD), ("process_id", wintypes.DWORD),
        ("priority", wintypes.LONG), ("priority_delta", wintypes.LONG),
        ("flags", wintypes.DWORD),
    ]


def _kernel32():
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    signatures = {
        "CreateJobObjectW": (wintypes.HANDLE, [ctypes.c_void_p, wintypes.LPCWSTR]),
        "SetInformationJobObject": (wintypes.BOOL, [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]),
        "AssignProcessToJobObject": (wintypes.BOOL, [wintypes.HANDLE, wintypes.HANDLE]),
        "QueryInformationJobObject": (wintypes.BOOL, [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]),
        "TerminateJobObject": (wintypes.BOOL, [wintypes.HANDLE, wintypes.UINT]),
        "CloseHandle": (wintypes.BOOL, [wintypes.HANDLE]),
        "CreateToolhelp32Snapshot": (wintypes.HANDLE, [wintypes.DWORD, wintypes.DWORD]),
        "Thread32First": (wintypes.BOOL, [wintypes.HANDLE, ctypes.POINTER(_ThreadEntry)]),
        "Thread32Next": (wintypes.BOOL, [wintypes.HANDLE, ctypes.POINTER(_ThreadEntry)]),
        "OpenThread": (wintypes.HANDLE, [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]),
        "GetProcessIdOfThread": (wintypes.DWORD, [wintypes.HANDLE]),
        "ResumeThread": (wintypes.DWORD, [wintypes.HANDLE]),
    }
    for name, (result, arguments) in signatures.items():
        function = getattr(api, name)
        function.restype = result
        function.argtypes = arguments
    return api


def _thread_ids(api, process_id: int) -> list[int]:
    snapshot = api.CreateToolhelp32Snapshot(0x00000004, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        entry = _ThreadEntry()
        entry.size = ctypes.sizeof(entry)
        found = []
        more = api.Thread32First(snapshot, ctypes.byref(entry))
        while more:
            if entry.process_id == process_id:
                found.append(entry.thread_id)
            more = api.Thread32Next(snapshot, ctypes.byref(entry))
        if ctypes.get_last_error() != 18:  # ERROR_NO_MORE_FILES
            raise ctypes.WinError(ctypes.get_last_error())
        return found
    finally:
        api.CloseHandle(snapshot)


def _resume_primary_thread(api, process: subprocess.Popen) -> None:
    # Popen closes CreateProcess's thread handle. The newly suspended process
    # must still have exactly one thread, and OpenThread must confirm its owner.
    threads = _thread_ids(api, process.pid)
    if len(threads) != 1 or process.poll() is not None:
        raise RuntimeError("Cannot identify the suspended subprocess primary thread")
    thread = api.OpenThread(0x0002 | 0x0800, False, threads[0])
    if not thread:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if api.GetProcessIdOfThread(thread) != process.pid:
            raise RuntimeError("Suspended subprocess thread ownership changed")
        previous = api.ResumeThread(thread)
        if previous == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())
        if previous != 1:
            raise RuntimeError("Unexpected subprocess primary thread suspend count")
    finally:
        api.CloseHandle(thread)


class WindowsProcessJob:
    def __init__(self) -> None:
        self._api = _kernel32()
        # No name or inheritable handle: this owner alone controls the job.
        self._handle = self._api.CreateJobObjectW(None, None)
        if not self._handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = _ExtendedLimits()
        limits.basic.flags = _KILL_ON_JOB_CLOSE
        if not self._api.SetInformationJobObject(self._handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def assign(self, process: subprocess.Popen) -> None:
        if not self._api.AssignProcessToJobObject(self._handle, int(process._handle)):
            raise ctypes.WinError(ctypes.get_last_error())

    def active_processes(self) -> int:
        if self._handle is None:
            return 0
        accounting = _Accounting()
        if not self._api.QueryInformationJobObject(self._handle, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return int(accounting.active)

    def terminate_and_wait(self, timeout_seconds: float = 5) -> None:
        if self._handle is None or not self.active_processes():
            return
        if not self._api.TerminateJobObject(self._handle, 1):
            raise ctypes.WinError(ctypes.get_last_error())
        deadline = time.monotonic() + max(0, timeout_seconds)
        while self.active_processes():
            if time.monotonic() >= deadline:
                raise TimeoutError("The owned subprocess job did not finish terminating")
            time.sleep(0.01)

    def close(self) -> None:
        if self._handle is not None:
            self._api.CloseHandle(self._handle)
            self._handle = None


def start_owned_process(command: list[str], **kwargs) -> tuple[subprocess.Popen, WindowsProcessJob | None]:
    if not _IS_WINDOWS:
        return subprocess.Popen(command, **kwargs), None
    job = WindowsProcessJob()
    process = None
    try:
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | _CREATE_SUSPENDED
        process = subprocess.Popen(command, **kwargs)
        job.assign(process)
        _resume_primary_thread(job._api, process)
        return process, job
    except BaseException:
        try:
            if process is not None:
                process.kill()
                process.wait(timeout=5)
        finally:
            job.close()
        raise
