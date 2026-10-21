"""Review provenance, independent of paragraph grouping and model confidence."""
import math

REVIEW_TIME_TOLERANCE_SECONDS = 0.15
REVIEW_REASONS = {
    "timing_estimated", "timing_legacy", "timestamp_adjusted", "speaker_unassigned", "speaker_split",
    "short_speaker_overlap", "speaker_coverage_gap", "speaker_coverage_overlap", "speaker_review",
}
REVIEW_LABELS = {
    "timing_estimated": "문장별 발화 시각을 추정한 구간",
    "timing_legacy": "이전 분석에서 시각을 추정·보정한 구간(세부 사유 없음)",
    "timestamp_adjusted": "음성 조각의 경계에 맞춰 시각을 보정한 구간",
    "speaker_unassigned": "참석자를 배정하지 못한 구간",
    "speaker_split": "한 인식 구간의 내용을 참석자별로 나눈 구간",
    "short_speaker_overlap": "짧은 다른 참석자 구간이 걸쳐 있는 부분",
    "speaker_coverage_gap": "참석자 음성 구간 사이에 빈틈이 있는 부분",
    "speaker_coverage_overlap": "서로 다른 참석자 음성 구간이 겹치는 부분",
    "speaker_review": "이전 분석에서 참석자 확인 대상으로 남긴 구간",
}


def seconds(value):
    try:
        parts = str(value).split(":")
        number = sum(float(part) * 60 ** index for index, part in enumerate(reversed(parts)))
        return number if math.isfinite(number) and number >= 0 else None
    except (TypeError, ValueError, OverflowError):
        return None


def issue(reason, start, end):
    start, end = seconds(start), seconds(end)
    if not isinstance(reason, str) or reason not in REVIEW_REASONS or start is None or end is None or end < start:
        return None
    return {"reason": reason, "start": start, "end": end}


def normalize_issues(values):
    normalized = []
    for value in values if isinstance(values, list) else []:
        if not isinstance(value, dict):
            continue
        item = issue(value.get("reason"), value.get("start"), value.get("end"))
        if item and item not in normalized:
            normalized.append(item)
    return sorted(normalized, key=lambda item: (item["start"], item["end"], item["reason"]))


def segment_review_issues(segment):
    if segment.get("review_version", segment.get("reviewVersion")) == 1:
        issues = normalize_issues(segment.get("review_issues", segment.get("reviewIssues", [])))
        if str(segment.get("speaker", "")).upper() in {"UNKNOWN", "UNASSIGNED"} and not any(entry["reason"] == "speaker_unassigned" for entry in issues):
            issues = normalize_issues([*issues, issue("speaker_unassigned", segment.get("start", 0), segment.get("end", segment.get("start", 0)))])
        return issues
    start, end = segment.get("start", 0), segment.get("end", segment.get("start", 0))
    reasons = []
    if segment.get("timing_approximate") or segment.get("timingApproximate"):
        reasons.append("timing_legacy")
    flags = {
        "short_speaker_overlap": "shortSpeakerOverlap",
        "speaker_split_coverage_gap": "speakerSplitCoverageGap",
        "speaker_split_coverage_overlap": "speakerSplitCoverageOverlap",
        "mixed_speaker_split": "mixedSpeakerSplit",
    }
    mapping = dict(zip(flags, ["short_speaker_overlap", "speaker_coverage_gap", "speaker_coverage_overlap", "speaker_split"]))
    for snake, camel in flags.items():
        if segment.get(snake) or segment.get(camel):
            reasons.append(mapping[snake])
    if str(segment.get("speaker", "")).upper() in {"UNKNOWN", "UNASSIGNED"}:
        reasons.append("speaker_unassigned")
    if (segment.get("speaker_needs_review") or segment.get("speakerNeedsReview")) and not any(reason.startswith("speaker_") or reason == "short_speaker_overlap" for reason in reasons):
        reasons.append("speaker_review")
    return normalize_issues([issue(reason, start, end) for reason in reasons])


def review_fields(segment):
    return {"review_version": 1, "review_issues": segment_review_issues(segment)}


def set_review_issues(segment, values):
    segment.update(review_version=1, review_issues=normalize_issues(values))
    return segment


def format_review_notes(segment):
    def stamp(value):
        ticks = round(value * 100)
        whole = ticks // 100
        return f"{whole//3600:02}:{whole//60%60:02}:{whole%60:02}.{ticks%100:02}"
    return [f"확인 {stamp(entry['start'])}–{stamp(entry['end'])} · {REVIEW_LABELS[entry['reason']]}" for entry in segment_review_issues(segment)]
