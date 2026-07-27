import os
import sys
import unittest
from pathlib import Path

# Ensure backend directory is in path
sys.path.insert(0, os.path.dirname(__file__))

from pipeline.transcribe import transcribe_audio
from model_manager import get_model_spec, model_exists, resolve_model_path
from main import load_config, BASE_DIR

DEFAULT_REAL_AUDIO_PATH = Path(BASE_DIR).parent / "video" / "portable_video_15s.mp4"


def resolve_real_audio_fixture() -> Path:
    configured_path = os.environ.get("LMO_REAL_AUDIO_FIXTURE", "").strip()
    return Path(configured_path).expanduser() if configured_path else DEFAULT_REAL_AUDIO_PATH


class TranscribeModuleTest(unittest.TestCase):

    def setUp(self):
        """Use a real speech sample so an empty transcript is meaningful."""
        self.test_audio_path = resolve_real_audio_fixture()
        if not self.test_audio_path.is_file():
            self.skipTest(
                "Real speech fixture is unavailable. Set LMO_REAL_AUDIO_FIXTURE "
                "to a short WAV/MP3/MP4 file containing clear speech."
            )

        self.config = load_config()
        self.stt_config = self.config.get("stt", {})
        self.selected_model_name = self.stt_config.get("selected_model", "faster-whisper-large-v3")

    def test_transcribe_short_audio(self):
        """
        Tests the transcribe_audio function with a short, known audio file.
        This verifies that the selected STT model can be loaded and can perform a basic transcription.
        """
        print(f"\n--- Running Transcription Test for '{self.selected_model_name}' ---")

        stt_spec_key = "stt_qwen" if self.selected_model_name == "qwen3-asr" else "stt_faster_whisper"
        stt_spec = get_model_spec(stt_spec_key)

        if not model_exists(BASE_DIR, stt_spec):
            self.skipTest(f"Required STT model '{stt_spec.label}' not found. Skipping test.")

        model_path = resolve_model_path(BASE_DIR, stt_spec)
        print(f"Using model path: {model_path}")

        qwen_aligner_model_path = None
        if self.selected_model_name == "qwen3-asr":
            aligner_spec = get_model_spec("stt_qwen_aligner")
            if not model_exists(BASE_DIR, aligner_spec):
                self.skipTest("Qwen Aligner model not found, which is required for Qwen ASR. Skipping test.")
            qwen_aligner_model_path = resolve_model_path(BASE_DIR, aligner_spec)
            print(f"Using Qwen aligner path: {qwen_aligner_model_path}")

        try:
            segments = transcribe_audio(
                wav_path=str(self.test_audio_path),
                model_path=model_path,
                language=self.stt_config.get("language", "ko"),
                device=self.stt_config.get("device", "auto"),
                chunk_seconds=self.stt_config.get("chunk_seconds", 30),
                fallback_model_path=None, # Fallback is not tested here
                qwen_aligner_model_path=qwen_aligner_model_path,
            )
            
            print("\n--- Transcription Result ---")
            print(f"Successfully transcribed. Number of segments: {len(segments)}")
            for i, seg in enumerate(segments):
                print(f"  Segment {i+1}: start={seg['start']:.2f}s, end={seg['end']:.2f}s, text='{seg['text']}'")
            print("--------------------------\n")

            self.assertIsInstance(segments, list)
            self.assertTrue(any(seg.get("text") for seg in segments), "At least one segment should have text.")

        except Exception as e:
            import traceback
            traceback.print_exc()
            self.fail(f"transcribe_audio function failed with an exception: {e}")

if __name__ == "__main__":
    unittest.main()