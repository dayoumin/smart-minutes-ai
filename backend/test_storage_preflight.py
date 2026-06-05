import os
import tempfile
import unittest

from storage_preflight import (
    ANALYSIS_OUTPUT_STORAGE_SAFETY_BYTES,
    ANALYSIS_STORAGE_SAFETY_BYTES,
    build_analysis_storage_preflight,
    estimate_analysis_required_storage_bytes,
    estimate_analysis_wav_size_bytes,
    format_storage_bytes,
)


class StoragePreflightTest(unittest.TestCase):
    def test_estimates_required_storage_from_source_size_and_duration(self) -> None:
        duration_seconds = 60 * 60
        source_size = 1024

        self.assertEqual(estimate_analysis_wav_size_bytes(duration_seconds), 115_200_000)
        self.assertEqual(
            estimate_analysis_required_storage_bytes(source_size, duration_seconds),
            source_size + (115_200_000 * 2) + ANALYSIS_STORAGE_SAFETY_BYTES,
        )

    def test_preflight_allows_when_storage_is_enough(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            temp_dir = os.path.join(work_dir, "temp")
            duration_seconds = 60 * 60
            file_size = 1024
            expected_required = estimate_analysis_required_storage_bytes(file_size, duration_seconds)

            payload = build_analysis_storage_preflight(
                temp_dir,
                file_size,
                duration_seconds,
                disk_usage=lambda _: (expected_required * 2, 0, expected_required + 1),
            )

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["level"], "ok")
        self.assertEqual(payload["reason"], "enough_storage")
        self.assertEqual(payload["required_bytes"], expected_required)

    def test_preflight_blocks_when_storage_is_low(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            temp_dir = os.path.join(work_dir, "temp")
            duration_seconds = 90 * 60
            file_size = 2048
            expected_required = estimate_analysis_required_storage_bytes(file_size, duration_seconds)

            payload = build_analysis_storage_preflight(
                temp_dir,
                file_size,
                duration_seconds,
                disk_usage=lambda _: (expected_required * 2, 0, expected_required - 1),
            )

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["level"], "error")
        self.assertEqual(payload["reason"], "not_enough_storage")
        self.assertEqual(payload["required_bytes"], expected_required)

    def test_preflight_blocks_when_output_storage_is_low(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            temp_dir = os.path.join(work_dir, "temp")
            output_dir = os.path.join(work_dir, "outputs")
            duration_seconds = 30 * 60
            file_size = 4096
            expected_required = estimate_analysis_required_storage_bytes(file_size, duration_seconds)

            def fake_disk_usage(path: str) -> tuple[int, int, int]:
                if os.path.basename(path) == "outputs":
                    return (ANALYSIS_OUTPUT_STORAGE_SAFETY_BYTES * 2, 0, ANALYSIS_OUTPUT_STORAGE_SAFETY_BYTES - 1)
                return (expected_required * 2, 0, expected_required + 1)

            payload = build_analysis_storage_preflight(
                temp_dir,
                file_size,
                duration_seconds,
                output_dir,
                disk_usage=fake_disk_usage,
            )

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["level"], "error")
        self.assertEqual(payload["reason"], "not_enough_output_storage")
        self.assertEqual(payload["required_bytes"], expected_required)
        self.assertEqual(payload["output_required_bytes"], ANALYSIS_OUTPUT_STORAGE_SAFETY_BYTES)

    def test_preflight_allows_at_exact_required_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            temp_dir = os.path.join(work_dir, "temp")
            duration_seconds = 30 * 60
            file_size = 4096
            expected_required = estimate_analysis_required_storage_bytes(file_size, duration_seconds)

            payload = build_analysis_storage_preflight(
                temp_dir,
                file_size,
                duration_seconds,
                disk_usage=lambda _: (expected_required * 2, 0, expected_required),
            )

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["level"], "ok")
        self.assertEqual(payload["reason"], "enough_storage")

    def test_preflight_uses_source_size_as_wav_fallback_when_duration_is_unknown(self) -> None:
        file_size = 10 * 1024 * 1024
        expected_required = file_size + (file_size * 2) + ANALYSIS_STORAGE_SAFETY_BYTES

        self.assertEqual(
            estimate_analysis_required_storage_bytes(file_size, None),
            expected_required,
        )
        self.assertEqual(
            estimate_analysis_required_storage_bytes(file_size, "unknown"),
            expected_required,
        )

    def test_estimates_zero_wav_size_for_invalid_duration(self) -> None:
        self.assertEqual(estimate_analysis_wav_size_bytes(None), 0)
        self.assertEqual(estimate_analysis_wav_size_bytes("unknown"), 0)
        self.assertEqual(estimate_analysis_wav_size_bytes(-1), 0)

    def test_estimates_zero_source_size_for_invalid_file_size(self) -> None:
        duration_seconds = 10
        expected_wav_size = estimate_analysis_wav_size_bytes(duration_seconds)

        self.assertEqual(
            estimate_analysis_required_storage_bytes(None, duration_seconds),
            (expected_wav_size * 2) + ANALYSIS_STORAGE_SAFETY_BYTES,
        )
        self.assertEqual(
            estimate_analysis_required_storage_bytes("unknown", duration_seconds),
            (expected_wav_size * 2) + ANALYSIS_STORAGE_SAFETY_BYTES,
        )
        self.assertEqual(
            estimate_analysis_required_storage_bytes(-100, duration_seconds),
            (expected_wav_size * 2) + ANALYSIS_STORAGE_SAFETY_BYTES,
        )

    def test_preflight_warns_when_disk_usage_check_fails(self) -> None:
        def raise_disk_usage(_: str) -> tuple[int, int, int]:
            raise OSError("disk check failed")

        with tempfile.TemporaryDirectory() as work_dir:
            temp_dir = os.path.join(work_dir, "temp")
            expected_required = estimate_analysis_required_storage_bytes(1024, 60)

            with self.assertLogs(level="ERROR"):
                payload = build_analysis_storage_preflight(
                    temp_dir,
                    1024,
                    60,
                    disk_usage=raise_disk_usage,
                )

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["level"], "warning")
        self.assertEqual(payload["reason"], "storage_check_unavailable")
        self.assertEqual(payload["required_bytes"], expected_required)
        self.assertIsNone(payload["available_bytes"])

    def test_preflight_blocks_when_temp_directory_cannot_be_prepared(self) -> None:
        def raise_ensure_dir(_: str, *, exist_ok: bool = False) -> None:
            raise OSError("temp directory denied")

        with tempfile.TemporaryDirectory() as work_dir:
            temp_dir = os.path.join(work_dir, "temp")
            expected_required = estimate_analysis_required_storage_bytes(1024, 60)

            with self.assertLogs(level="ERROR"):
                payload = build_analysis_storage_preflight(
                    temp_dir,
                    1024,
                    60,
                    ensure_dir=raise_ensure_dir,
                )

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["level"], "error")
        self.assertEqual(payload["reason"], "temp_dir_unavailable")
        self.assertEqual(payload["required_bytes"], expected_required)
        self.assertIsNone(payload["available_bytes"])

    def test_preflight_blocks_when_output_directory_cannot_be_prepared(self) -> None:
        def raise_output_dir(path: str, *, exist_ok: bool = False) -> None:
            if os.path.basename(path) == "outputs":
                raise OSError("output directory denied")
            os.makedirs(path, exist_ok=exist_ok)

        with tempfile.TemporaryDirectory() as work_dir:
            temp_dir = os.path.join(work_dir, "temp")
            output_dir = os.path.join(work_dir, "outputs")
            expected_required = estimate_analysis_required_storage_bytes(1024, 60)

            with self.assertLogs(level="ERROR"):
                payload = build_analysis_storage_preflight(
                    temp_dir,
                    1024,
                    60,
                    output_dir,
                    ensure_dir=raise_output_dir,
                )

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["level"], "error")
        self.assertEqual(payload["reason"], "output_dir_unavailable")
        self.assertEqual(payload["required_bytes"], expected_required)
        self.assertEqual(payload["output_required_bytes"], ANALYSIS_OUTPUT_STORAGE_SAFETY_BYTES)

    def test_formats_storage_bytes_for_user_messages(self) -> None:
        self.assertEqual(format_storage_bytes(None), "-")
        self.assertEqual(format_storage_bytes(-1), "0 B")
        self.assertEqual(format_storage_bytes(512), "512 B")
        self.assertEqual(format_storage_bytes(1024), "1.0 KB")
        self.assertEqual(format_storage_bytes(1024 * 1024 * 3), "3.0 MB")
        self.assertEqual(format_storage_bytes(1024 * 1024 * 1024 * 2), "2.0 GB")


if __name__ == "__main__":
    unittest.main()
