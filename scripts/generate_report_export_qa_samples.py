from __future__ import annotations

import copy
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from pipeline.export_docx import export_docx  # noqa: E402
from pipeline.export_hwpx import export_hwpx  # noqa: E402
from pipeline.export_markdown import export_markdown  # noqa: E402


OUTPUT_DIR = PROJECT_ROOT / ".tmp" / "report_export_qa"


def _sample_result(export_scope: str) -> dict:
    report_template = {
        "id": "lmo-committee-report",
        "name": "LMO 심사 보고 양식",
        "purpose": "심사 배경, 주요 검토, 결정사항, 후속 조치를 제출용으로 정리합니다.",
        "sections": ["검토 배경", "주요 검토", "결정사항", "후속 조치"],
        "requiredSections": ["검토 배경", "주요 검토"],
        "optionalSections": ["결정사항", "후속 조치"],
        "tone": "report",
        "detailLevel": "standard",
    }
    return {
        "job_id": "report-export-qa",
        "export_scope": export_scope,
        "source_file": "LMO_심사위원회_샘플.mp4",
        "created_at": "2026-06-16 16:20",
        "meeting_purpose": "LMO 심사 회의 보고서 저장 품질 확인",
        "selected_report_template_id": report_template["id"],
        "report_template": report_template,
        "meeting_report": {
            "templateId": report_template["id"],
            "templateName": report_template["name"],
            "templateSnapshot": report_template,
            "generatedAt": "2026-06-16T16:20:00",
            "content": (
                "LMO 심사 회의에서는 신청 과제의 위해성 평가 근거, 보완 요청, "
                "후속 제출 일정을 중심으로 검토했습니다.\n"
                "- 표와 문단 간격이 과도하게 벌어지지 않아야 합니다.\n"
                "- 긴 문장과 긴 고유명사가 줄바꿈되어도 본문 영역을 벗어나지 않아야 합니다."
            ),
            "sections": [
                {
                    "title": "검토 배경",
                    "content": "신청 과제의 목적, 실험 범위, 제출 자료의 완결성을 확인했습니다.",
                },
                {
                    "title": "주요 검토",
                    "content": (
                        "위해성 평가 근거와 시설 관리 계획을 중심으로 검토했습니다.\n"
                        "- LMO 표기와 기관 용어가 유지되는지 확인합니다.\n"
                        "- 문단, 불릿, 숫자 목록이 Word와 한글 뷰어에서 자연스럽게 표시되는지 확인합니다."
                    ),
                },
                {
                    "title": "결정사항",
                    "content": "보완 자료 제출 후 차기 회의에서 재검토하기로 했습니다.",
                },
                {
                    "title": "후속 조치",
                    "content": "담당자는 보완 요청 목록을 정리해 2026-06-20까지 공유합니다.",
                },
                {
                    "title": "참고",
                    "content": "모델이 양식 밖 섹션을 반환한 경우 원문 제목과 본문은 참고 섹션으로 보존합니다.",
                },
            ],
        },
        "summary": {
            "title": "LMO 심사 보고서 QA 샘플",
            "overview": "보고서 저장 품질 확인을 위한 샘플 회의입니다.",
            "topics": ["검토 배경", "주요 검토", "후속 조치"],
            "topic_sections": [
                {"topic": "검토 배경", "summary": "제출 자료와 회의 목적을 확인했습니다."},
                {"topic": "후속 조치", "summary": "보완 자료 제출 일정을 정했습니다."},
            ],
            "participant_summaries": [
                {"participant": "참석자01", "summary": "검토 기준을 설명했습니다.", "key_points": ["심사 기준"], "actions": []},
                {"participant": "참석자02", "summary": "보완 요청을 정리했습니다.", "key_points": ["보완 자료"], "actions": ["요청 목록 공유"]},
            ],
            "actions": ["보완 요청 목록 공유"],
            "decisions": ["보완 자료 제출 후 재검토"],
            "needs_check": ["기관 제출 양식과 번호 체계 일치 여부"],
        },
        "segments": [
            {"start": 1.0, "end": 5.0, "speaker": "SPEAKER_00", "speaker_name": "참석자01", "text": "오늘은 LMO 심사 자료를 검토하겠습니다."},
            {"start": 6.0, "end": 12.0, "speaker": "SPEAKER_01", "speaker_name": "참석자02", "text": "위해성 평가 근거와 보완 요청 사항을 확인했습니다."},
        ],
    }


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report_result = _sample_result("report")
    full_result = _sample_result("full")

    export_markdown(copy.deepcopy(report_result), str(OUTPUT_DIR / "report_scope.md"))
    export_docx(copy.deepcopy(report_result), str(OUTPUT_DIR / "report_scope.docx"))
    export_hwpx(copy.deepcopy(report_result), str(OUTPUT_DIR / "report_scope.hwpx"))
    export_markdown(copy.deepcopy(full_result), str(OUTPUT_DIR / "full_scope.md"))

    print(f"Generated report export QA samples: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
