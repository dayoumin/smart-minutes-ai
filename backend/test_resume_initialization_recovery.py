"""Crash-window recovery tests; native audio/model work is never started."""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import main
from job_checkpoints import atomic_write_json, build_job_checkpoint_paths, load_json_checkpoint


class SimulatedTermination(BaseException):
    """Interrupt the Python control flow without taking the graceful-stop path."""


def write_wav(path, seconds, sample=b"\0\0"):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(2)
        output.writeframes(sample * (seconds * 2))


class ResumeInitializationRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="resume-init-", dir=Path(__file__).resolve().parents[1] / ".tmp")
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.job_id = "resume_initialization"
        self.config = main.normalize_app_config({
            "paths": {"temp_dir": str(self.root / "temp"), "output_dir": str(self.root / "outputs"),
                      "stt_model": str(self.root / "faster-whisper-large-v3"), "ffmpeg": "ffmpeg"},
            "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
            "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
            "preprocessing": {"enabled": False}, "diarization": {"enabled": False},
            "summary": {"enabled": False},
            "privacy": {"auto_delete_temp_audio": False, "preserve_extracted_audio": True},
        })
        self.paths = build_job_checkpoint_paths(self.config["paths"]["temp_dir"], self.job_id)
        self.source = self.root / "original.wav"
        write_wav(self.source, 60)
        write_wav(self.paths.source_wav_path, 60)
        self.input_sha = main.hash_file_contents(str(self.source))
        self.config_sha = main._analysis_config_fingerprint(self.config)
        self.size = self.source.stat().st_size
        self.modified = 123456789
        self.progress = {"progress": 64, "status": "processing", "message": "saved chunk progress"}
        chunks = []
        self.checkpoints = []
        execution = main._stt_execution_fingerprint(self.config["paths"]["stt_model"], "cpu", 30)
        for index in range(2):
            chunk = Path(self.paths.chunks_dir) / f"chunk_{index + 1:03d}.wav"
            write_wav(chunk, 30)
            chunks.append({"path": str(chunk), "index": index, "offset": index * 30,
                           "duration": 30, "size_bytes": chunk.stat().st_size})
            checkpoint = Path(self.paths.stt_dir) / f"chunk_{index + 1:03d}.json"
            atomic_write_json(str(checkpoint), {
                "chunk_index": index, "input_fingerprint": self.input_sha, "config_fingerprint": self.config_sha,
                "source_wav_size": Path(self.paths.source_wav_path).stat().st_size, "source_wav_duration": 60,
                "chunk_path": str(chunk), "chunk_size_bytes": chunk.stat().st_size,
                "offset": index * 30, "duration": 30, "stt_execution_fingerprint": execution,
                "segments": [{"start": 0.0, "end": 1.0, "text": "saved utterance"}],
            })
            self.checkpoints.append(checkpoint)
        atomic_write_json(self.paths.chunk_manifest_path, {
            "input_fingerprint": self.input_sha, "config_fingerprint": self.config_sha,
            "source_wav_size": Path(self.paths.source_wav_path).stat().st_size,
            "long_chunk_seconds": 30, "enable_chunking": True, "chunks": chunks,
        })
        atomic_write_json(self.paths.state_path, {
            "job_id": self.job_id, "stage": "stopped", "cancelled": True, "cancel_action": "stop",
            "source_filename": self.source.name, "source_file": self.source.name,
            "source_size": self.size, "source_last_modified": self.modified,
            "input_fingerprint": self.input_sha, "config_fingerprint": self.config_sha,
            "resume_requested": True, "resume_supported": True, "completed_chunk_indices": [0, 1],
            "chunk_count": 2, "source_wav_completed": True,
            "source_wav_size": Path(self.paths.source_wav_path).stat().st_size,
            "source_wav_duration": 60, "last_progress": self.progress,
        })
        self.before = [(p.read_bytes(), p.stat().st_mtime_ns) for p in self.checkpoints]

    def seed(self, config=None, resume=True):
        main._seed_analysis_job_state(job_id=self.job_id, config=config or self.config,
                                      source_filename=self.source.name, source_size=self.size,
                                      source_last_modified=self.modified, resume_requested=resume)

    def assert_candidate(self):
        candidates = main._find_resume_candidates(config=self.config, source_filename=self.source.name,
                                                  source_size=self.size, source_last_modified=self.modified)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["job_id"], self.job_id)
        self.assertEqual(candidates[0]["completed_chunk_count"], 2)
        self.assertEqual([(p.read_bytes(), p.stat().st_mtime_ns) for p in self.checkpoints], self.before)

    def interrupt_pipeline(self, message, config=None):
        def progress(step, _percent, _metadata=None):
            if step == message:
                raise SimulatedTermination()

        with patch.object(main, "model_exists", return_value=False), patch("pipeline.transcribe.transcribe_audio") as transcribe:
            with self.assertRaises(SimulatedTermination):
                main.process_audio_pipeline(str(self.source), self.job_id, config or self.config, progress_callback=progress)
            transcribe.assert_not_called()

    def test_resume_seed_preserves_progress_without_relabeling_cached_identity(self):
        self.seed()
        self.assert_candidate()
        state = load_json_checkpoint(self.paths.state_path)
        self.assertEqual(state["last_progress"], self.progress)
        self.assertEqual(state["input_fingerprint"], self.input_sha)
        self.assertEqual(state["config_fingerprint"], self.config_sha)

    def test_abrupt_exit_during_preprocessing_preserves_completed_progress(self):
        self.seed()
        self.interrupt_pipeline("Converting to WAV...")
        self.assert_candidate()

    def test_abrupt_exit_before_first_cache_lookup_is_visible_in_a_fresh_process(self):
        self.seed()
        self.interrupt_pipeline("Transcribing chunk 1/2...")
        self.assert_candidate()
        script = """import json,sys,main
x=json.load(sys.stdin)
rows=main._find_resume_candidates(config=x['config'],source_filename=x['filename'],source_size=x['size'],source_last_modified=x['modified'])
print(json.dumps({'counts':[row['completed_chunk_count'] for row in rows],'active':[row['active'] for row in rows]}))
"""
        result = subprocess.run([sys.executable, "-B", "-X", "utf8", "-c", script],
                                cwd=Path(main.__file__).parent, input=json.dumps({"config": self.config,
                                "filename": self.source.name, "size": self.size, "modified": self.modified}),
                                encoding="utf-8", capture_output=True, timeout=15, check=True)
        self.assertEqual(json.loads(result.stdout), {"counts": [2], "active": [False]})

    def test_changed_config_cannot_be_relabelled_as_a_valid_old_cache(self):
        changed = copy.deepcopy(self.config)
        changed["stt"]["language"] = "en"
        self.seed(config=changed)
        self.assertEqual(load_json_checkpoint(self.paths.state_path)["config_fingerprint"], self.config_sha)
        self.interrupt_pipeline("Converting to WAV...", config=changed)
        state = load_json_checkpoint(self.paths.state_path)
        self.assertEqual(state["resume_mode"], "fallback_fresh_start")
        self.assertEqual(state["resume_fallback_reason"], "fingerprint_mismatch")
        self.assertEqual(state["completed_chunk_indices"], [])
        self.assertFalse(state["resume_supported"])
        self.assertTrue(all(not p.exists() for p in self.checkpoints))

    def test_different_input_invalidates_old_progress_before_fresh_processing(self):
        write_wav(self.source, 60, sample=b"\1\0")
        self.seed()
        self.interrupt_pipeline("Converting to WAV...")
        state = load_json_checkpoint(self.paths.state_path)
        self.assertEqual(state["resume_fallback_reason"], "fingerprint_mismatch")
        self.assertEqual(state["completed_chunk_indices"], [])
        self.assertFalse(state["resume_supported"])
        self.assertTrue(all(not p.exists() for p in self.checkpoints))

    def test_fresh_request_does_not_advertise_old_resume_progress(self):
        self.seed(resume=False)
        state = load_json_checkpoint(self.paths.state_path)
        self.assertFalse(state["resume_requested"])
        self.assertFalse(state["resume_supported"])
        self.assertEqual(main._find_resume_candidates(config=self.config, source_filename=self.source.name,
                         source_size=self.size, source_last_modified=self.modified), [])

    def test_changed_source_metadata_cannot_advertise_previous_progress(self):
        main._seed_analysis_job_state(job_id=self.job_id, config=self.config, source_filename="different.wav",
                                      source_size=self.size, source_last_modified=self.modified, resume_requested=True)
        state = load_json_checkpoint(self.paths.state_path)
        self.assertFalse(state["resume_supported"])
        self.assertEqual(state["completed_chunk_indices"], [])
        self.assertEqual(state["input_fingerprint"], self.input_sha)
        self.assertEqual(main._find_resume_candidates(config=self.config, source_filename="different.wav",
                         source_size=self.size, source_last_modified=self.modified), [])

    def test_missing_old_config_identity_cannot_enable_reuse(self):
        state = load_json_checkpoint(self.paths.state_path)
        state.pop("config_fingerprint")
        atomic_write_json(self.paths.state_path, state)
        self.seed()
        self.assertIsNone(load_json_checkpoint(self.paths.state_path)["config_fingerprint"])
        self.interrupt_pipeline("Converting to WAV...")
        state = load_json_checkpoint(self.paths.state_path)
        self.assertEqual(state["resume_fallback_reason"], "fingerprint_mismatch")
        self.assertFalse(state["resume_supported"])
        self.assertTrue(all(not p.exists() for p in self.checkpoints))


if __name__ == "__main__":
    unittest.main()
