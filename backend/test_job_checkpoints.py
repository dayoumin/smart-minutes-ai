import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from job_checkpoints import (
    CorruptCheckpointError,
    atomic_write_json,
    build_config_fingerprint,
    build_job_checkpoint_paths,
    ensure_job_checkpoint_dirs,
    hash_file_contents,
    load_json_checkpoint,
)


class JobCheckpointTest(unittest.TestCase):
    def test_build_job_checkpoint_paths_scopes_everything_under_job_dir(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = build_job_checkpoint_paths(temp_dir, "job-123")

            self.assertTrue(paths.root_dir.startswith(os.path.abspath(temp_dir)))
            self.assertEqual(paths.state_path, os.path.join(paths.root_dir, "job_state.json"))
            self.assertEqual(paths.audio_dir, os.path.join(paths.root_dir, "audio"))
            self.assertEqual(paths.source_wav_path, os.path.join(paths.audio_dir, "source.wav"))
            self.assertEqual(paths.chunks_dir, os.path.join(paths.root_dir, "chunks"))
            self.assertEqual(paths.chunk_manifest_path, os.path.join(paths.chunks_dir, "manifest.json"))
            self.assertEqual(paths.stt_dir, os.path.join(paths.root_dir, "stt"))

    def test_ensure_job_checkpoint_dirs_creates_expected_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = build_job_checkpoint_paths(temp_dir, "job-123")
            ensure_job_checkpoint_dirs(paths)

            self.assertTrue(os.path.isdir(paths.root_dir))
            self.assertTrue(os.path.isdir(paths.audio_dir))
            self.assertTrue(os.path.isdir(paths.chunks_dir))
            self.assertTrue(os.path.isdir(paths.stt_dir))
            self.assertTrue(os.path.isdir(paths.diarization_dir))
            self.assertTrue(os.path.isdir(paths.transcript_dir))

    def test_atomic_write_json_replaces_target_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = os.path.join(temp_dir, "job_state.json")
            atomic_write_json(target, {"stage": "stt", "completed_chunk_indices": [0, 1]})
            payload = load_json_checkpoint(target)

            self.assertEqual(payload, {"stage": "stt", "completed_chunk_indices": [0, 1]})
            self.assertFalse(os.path.exists(f"{target}.tmp"))

    def test_load_json_checkpoint_raises_for_corrupt_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = os.path.join(temp_dir, "job_state.json")
            with open(target, "w", encoding="utf-8") as handle:
                handle.write("{not-json")

            with self.assertRaises(CorruptCheckpointError):
                load_json_checkpoint(target)

    def test_hash_file_contents_is_stable_for_same_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = os.path.join(temp_dir, "sample.bin")
            with open(target, "wb") as handle:
                handle.write(b"smart-minutes-audio")

            first = hash_file_contents(target)
            second = hash_file_contents(target)

            self.assertEqual(first, second)

    def test_build_config_fingerprint_changes_with_config(self) -> None:
        first = build_config_fingerprint({"stt": {"device": "cpu"}, "processing": {"long_audio_chunk_seconds": 90}})
        second = build_config_fingerprint({"stt": {"device": "cpu"}, "processing": {"long_audio_chunk_seconds": 30}})

        self.assertNotEqual(first, second)


if __name__ == "__main__":
    unittest.main()
