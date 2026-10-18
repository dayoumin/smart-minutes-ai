import errno
import unittest

from analysis_errors import (
    INSUFFICIENT_MEMORY,
    INSUFFICIENT_STORAGE,
    UNSUPPORTED_MEDIA,
    classify_analysis_failure,
)


class ClassifyAnalysisFailureTest(unittest.TestCase):
    def test_memory_failures(self):
        self.assertEqual(classify_analysis_failure(MemoryError()), INSUFFICIENT_MEMORY)
        self.assertEqual(
            classify_analysis_failure(RuntimeError("CUDA failed with error out of memory")),
            INSUFFICIENT_MEMORY,
        )
        self.assertEqual(classify_analysis_failure(RuntimeError("std::bad_alloc")), INSUFFICIENT_MEMORY)

    def test_storage_failures(self):
        self.assertEqual(
            classify_analysis_failure(OSError(errno.ENOSPC, "No space left on device")),
            INSUFFICIENT_STORAGE,
        )
        self.assertEqual(
            classify_analysis_failure(RuntimeError("ffmpeg chunking failed: ... No space left on device")),
            INSUFFICIENT_STORAGE,
        )
        disk_full = OSError(28, "There is not enough space on the disk")
        self.assertEqual(classify_analysis_failure(disk_full), INSUFFICIENT_STORAGE)

    def test_undecodable_media(self):
        self.assertEqual(
            classify_analysis_failure(RuntimeError(
                "ffmpeg conversion failed: sample.m4a: Invalid data found when processing input",
            )),
            UNSUPPORTED_MEDIA,
        )
        self.assertEqual(
            classify_analysis_failure(RuntimeError(
                "ffmpeg conversion failed: Output file #0 does not contain any stream",
            )),
            UNSUPPORTED_MEDIA,
        )

    def test_unknown_causes_stay_unclassified(self):
        # A missing ffmpeg binary is not a problem with the user's file.
        self.assertIsNone(classify_analysis_failure(RuntimeError("ffmpeg conversion failed: [WinError 2] 지정된 파일을 찾을 수 없습니다")))
        self.assertIsNone(classify_analysis_failure(ValueError("unexpected")))
        # A code bug and an ffmpeg warning are not a problem with the user's file.
        self.assertIsNone(classify_analysis_failure(ValueError("Unknown format code 'd' for object of type 'float'")))
        self.assertIsNone(classify_analysis_failure(RuntimeError(
            "ffmpeg chunking failed: Could not find codec parameters for stream 1 (Video: none)",
        )))
        self.assertIsNone(classify_analysis_failure(OSError(errno.EACCES, "Permission denied")))


if __name__ == "__main__":
    unittest.main()
