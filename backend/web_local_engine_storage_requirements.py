"""Post-install storage the web local engine needs, written into poc-manifest.json.

The installer preflight compares these values with the free space of the user
data volume (%LOCALAPPDATA%\\Barorok\\LocalEngine). Every value comes from a
backend constant or a recorded measurement so the release build, the installer
and the analysis-time checks agree. When a source value changes, update the
constant here and the note in docs/web-local-engine-followup-plan.md.

Run as a script to print the manifest block as ASCII JSON for the release build.
"""
from __future__ import annotations

import json
import sys

from media_limits import MAX_MEDIA_DURATION_SECONDS
from storage_preflight import (
    ANALYSIS_OUTPUT_STORAGE_SAFETY_BYTES,
    ANALYSIS_WAV_BYTES_PER_SAMPLE,
    estimate_analysis_required_storage_bytes,
)
from web_local_engine_download_sizes import (
    DIARIZATION_MODEL_BYTES,
    DOWNLOAD_FREE_SPACE_BUFFER_BYTES,
    STT_MODEL_BYTES,
    SUMMARY_MODEL_BYTES,
    SUMMARY_RUNTIME_ARCHIVE_BYTES,
    SUMMARY_RUNTIME_INSTALLED_BYTES,
)

# Room for meeting history beyond the per-analysis output margin. A 120-minute
# meeting left 2,757,163 bytes of results on 2026-10-19, so about 290 meetings fit.
RESULTS_RECOMMENDED_BYTES = 1024 ** 3


def _pcm_recording_bytes(duration_seconds: int, sample_rate: int, channels: int) -> int:
    return duration_seconds * sample_rate * channels * ANALYSIS_WAV_BYTES_PER_SAMPLE


def storage_requirements() -> dict[str, dict[str, object]]:
    models_ready = (
        STT_MODEL_BYTES
        + DIARIZATION_MODEL_BYTES
        + SUMMARY_MODEL_BYTES
        + SUMMARY_RUNTIME_INSTALLED_BYTES
    )
    # The summary program unpacks its archive and then copies the unpacked
    # files into place, so all three coexist. The summary model needs the
    # program, so it cannot be pulled before that peak.
    summary_runtime_peak = (
        STT_MODEL_BYTES
        + DIARIZATION_MODEL_BYTES
        + SUMMARY_RUNTIME_ARCHIVE_BYTES
        + 2 * SUMMARY_RUNTIME_INSTALLED_BYTES
    )
    models_recommended = max(models_ready, summary_runtime_peak) + DOWNLOAD_FREE_SPACE_BUFFER_BYTES

    longest = MAX_MEDIA_DURATION_SECONDS
    analysis_required = estimate_analysis_required_storage_bytes(
        _pcm_recording_bytes(longest, 16_000, 1),
        longest,
    )
    analysis_recommended = estimate_analysis_required_storage_bytes(
        _pcm_recording_bytes(longest, 48_000, 2),
        longest,
    )

    return {
        "models": {
            "requiredBytes": models_ready,
            "recommendedBytes": models_recommended,
            "basis": (
                "Required: speech recognition model + speaker separation model + default summary "
                "model + installed summary program. Recommended: peak while the summary program "
                "is unpacked (archive + unpacked copy + installed copy) plus the backend download buffer."
            ),
        },
        "analysisTemp": {
            "requiredBytes": analysis_required,
            "recommendedBytes": analysis_recommended,
            "basis": (
                "Backend analysis estimate (source + 2 x 16 kHz mono PCM16 WAV + 1 GiB) for the "
                "maximum supported length. Required uses a 16 kHz mono PCM source, recommended "
                "a 48 kHz stereo PCM16 WAV recording."
            ),
        },
        "results": {
            "requiredBytes": ANALYSIS_OUTPUT_STORAGE_SAFETY_BYTES,
            "recommendedBytes": RESULTS_RECOMMENDED_BYTES,
            "basis": (
                "Required: backend output margin checked before each analysis. Recommended: "
                "1 GiB, about 290 measured 120-minute meeting results beyond that margin."
            ),
        },
    }


def main() -> int:
    sys.stdout.write(json.dumps(storage_requirements(), ensure_ascii=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
