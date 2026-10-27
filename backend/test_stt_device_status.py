import types
import unittest
from pathlib import Path
from unittest.mock import patch

from pipeline import transcribe


class SttDeviceStatusTest(unittest.TestCase):
    def probe(self, count=1, compute_types=None, runtime=True):
        engine = types.SimpleNamespace(
            get_cuda_device_count=lambda: count,
            get_supported_compute_types=lambda device: compute_types if compute_types is not None else {"float16"},
        )
        cpu_torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
        with patch.dict("sys.modules", {"ctranslate2": engine, "torch": cpu_torch}), patch.object(
            transcribe, "_windows_cuda_runtime_is_usable", return_value=runtime
        ):
            return transcribe.get_stt_device_status()

    def test_cpu_torch_does_not_hide_ctranslate_gpu(self):
        status = self.probe()
        self.assertTrue(status["gpu_detected"])
        self.assertTrue(status["gpu_usable"])
        self.assertEqual(status["selected_device_allowed"], ["cpu", "cuda"])

    def test_missing_runtime_preserves_detection_but_blocks_cuda(self):
        status = self.probe(runtime=False)
        self.assertTrue(status["gpu_detected"])
        self.assertFalse(status["gpu_usable"])
        self.assertEqual(status["selected_device_allowed"], ["cpu"])

    def test_no_device_and_unsupported_compute_stay_on_cpu(self):
        self.assertFalse(self.probe(count=0)["gpu_detected"])
        status = self.probe(compute_types={"float32"})
        self.assertTrue(status["gpu_detected"])
        self.assertFalse(status["gpu_usable"])

    def test_compute_probe_failure_preserves_device_detection(self):
        engine = types.SimpleNamespace(get_cuda_device_count=lambda: 1, get_supported_compute_types=lambda device: 1 / 0)
        with patch.dict("sys.modules", {"ctranslate2": engine}), self.assertLogs(level="ERROR"):
            status = transcribe.get_stt_device_status()
        self.assertTrue(status["gpu_detected"])
        self.assertFalse(status["gpu_usable"])

    def test_driver_probe_failure_is_safe(self):
        engine = types.SimpleNamespace(get_cuda_device_count=lambda: 1 / 0)
        with patch.dict("sys.modules", {"ctranslate2": engine}), self.assertLogs(level="ERROR"):
            status = transcribe.get_stt_device_status()
        self.assertFalse(status["gpu_usable"])
        self.assertEqual(status["selected_device_allowed"], ["cpu"])

    def test_explicit_cuda_prepares_libraries_without_status_request(self):
        model = types.SimpleNamespace(transcribe=lambda *args, **kwargs: (iter([]), {}))
        with patch.object(transcribe, "_windows_cuda_runtime_is_usable", return_value=True) as preflight, patch.object(
            transcribe, "_get_faster_whisper_model", return_value=model
        ) as load:
            transcribe.transcribe_audio_fallback_whisper("unused.wav", "local-model", device="cuda")
        preflight.assert_called_once()
        self.assertEqual(load.call_args.args[1:3], ("cuda", "float16"))

    def test_explicit_cuda_missing_runtime_does_not_silently_use_cpu(self):
        with patch.object(transcribe, "_windows_cuda_runtime_is_usable", return_value=False), patch.object(
            transcribe, "_get_faster_whisper_model"
        ) as load:
            with self.assertRaisesRegex(RuntimeError, "CUDA runtime"):
                transcribe.transcribe_audio_fallback_whisper("unused.wav", "local-model", device="cuda")
        load.assert_not_called()

    def test_absolute_library_fallback_and_success_cache(self):
        library = object()
        with patch.object(transcribe, "_CUDA_DLL_HANDLES", {}), patch.object(
            transcribe, "_cuda_library_directories", return_value=[Path("runtime/cuda_v12")]
        ), patch.object(Path, "is_file", return_value=True), patch.object(
            transcribe.ctypes, "WinDLL", side_effect=[OSError("not in PATH"), library], create=True
        ) as loader:
            transcribe._load_cuda_library("cublas64_12.dll")
            transcribe._load_cuda_library("cublas64_12.dll")
        self.assertEqual(loader.call_count, 2)
        self.assertTrue(Path(loader.call_args.args[0]).is_absolute())

    def test_library_search_includes_bundled_cudnn_without_importing_engine(self):
        spec = types.SimpleNamespace(submodule_search_locations=["python/site-packages/ctranslate2"])
        with patch.object(transcribe.importlib.util, "find_spec", return_value=spec), patch(
            "ollama_utils.find_embedded_ollama_executable", return_value="app/runtime/ollama/ollama.exe"
        ):
            directories = transcribe._cuda_library_directories()
        self.assertIn(Path("python/site-packages/ctranslate2"), directories)
        self.assertIn(Path("app/runtime/ollama/lib/ollama/cuda_v12"), directories)

    def test_missing_library_can_recover_on_next_check(self):
        with patch.object(transcribe, "_CUDA_DLL_HANDLES", {}), patch.object(
            transcribe, "_cuda_library_directories", return_value=[]
        ), patch.object(transcribe.ctypes, "WinDLL", side_effect=[OSError("missing"), object()], create=True):
            with self.assertRaises(OSError):
                transcribe._load_cuda_library("cublas64_12.dll")
            transcribe._load_cuda_library("cublas64_12.dll")


if __name__ == "__main__":
    unittest.main()
