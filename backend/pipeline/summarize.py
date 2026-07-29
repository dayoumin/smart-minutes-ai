import json
import os
import re
from config_normalization import is_local_summary_model_path
from generation_gateway import classify_generation_exception, failure_for_code, generate_ollama_text


EMPTY_SUMMARY = {
    "title": "회의록",
    "overview": "",
    "topics": [],
    "topic_sections": [],
    "participant_summaries": [],
    "decisions": [],
    "actions": [],
    "needs_check": [],
}

MAX_DIRECT_SUMMARY_CHARS = 8000
SUMMARY_CHUNK_CHARS = 6000
GENERIC_SINGLE_TOPIC_TITLES = {"핵심 주제", "주요 주제", "전체 요약", "회의 요약", "전체 대화"}
MAX_CONTEXT_GLOSSARY_ENTRIES = 80


def _reject_generic_single_topic(sections: list[dict]) -> list[dict]:
    if len(sections) != 1:
        return sections
    topic = str(sections[0].get("topic") or "").strip()
    return [] if topic in GENERIC_SINGLE_TOPIC_TITLES else sections


def _parse_llm_json(result_text: str) -> dict | list:
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", result_text).strip()
    if text.startswith("```json"):
        text = text[7:].strip()
    elif text.startswith("```"):
        text = text[3:].strip()
    if text.endswith("```"):
        text = text[:-3].strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char not in "{[":
            continue
        try:
            parsed, _end = decoder.raw_decode(text[index:])
            if isinstance(parsed, (dict, list)):
                return parsed
        except json.JSONDecodeError:
            continue
    raise json.JSONDecodeError("No JSON object or array found in LLM response", text, 0)


def _normalize_summary(data: dict) -> dict:
    summary = dict(EMPTY_SUMMARY)
    if isinstance(data, dict):
        summary.update({key: data.get(key, summary[key]) for key in summary})
    for key in ("topics", "decisions", "actions", "needs_check"):
        if not isinstance(summary[key], list):
            summary[key] = [str(summary[key])] if summary[key] else []
    if not isinstance(summary["topic_sections"], list):
        summary["topic_sections"] = []
    summary["topic_sections"] = [
        {
            "topic": str(item.get("topic", "")).strip(),
            "summary": str(item.get("summary", "")).strip(),
            "evidence": item.get("evidence", []) if isinstance(item.get("evidence", []), list) else [],
            "actions": item.get("actions", []) if isinstance(item.get("actions", []), list) else [],
        }
        for item in summary["topic_sections"]
        if isinstance(item, dict) and str(item.get("topic", "")).strip()
    ]
    if not isinstance(summary["participant_summaries"], list):
        summary["participant_summaries"] = []
    summary["participant_summaries"] = [
        {
            "participant": str(item.get("participant", "")).strip(),
            "summary": str(item.get("summary", "")).strip(),
            "key_points": item.get("key_points", []) if isinstance(item.get("key_points", []), list) else [],
            "actions": item.get("actions", []) if isinstance(item.get("actions", []), list) else [],
        }
        for item in summary["participant_summaries"]
        if isinstance(item, dict) and str(item.get("participant", "")).strip()
    ]
    return summary


def _context_lines_from_report_template(template: dict) -> list[str]:
    if not isinstance(template, dict):
        return []
    lines = []
    name = str(template.get("name") or "").strip()
    purpose = str(template.get("purpose") or "").strip()
    sections = template.get("sections") if isinstance(template.get("sections"), list) else []
    tone = str(template.get("tone") or "").strip()
    detail_level = str(template.get("detailLevel") or template.get("detail_level") or "").strip()
    if name:
        lines.append(f"- 보고서 양식: {name}")
    if purpose:
        lines.append(f"- 양식 목적: {purpose}")
    if sections:
        section_text = ", ".join(str(section).strip() for section in sections if str(section).strip())
        if section_text:
            lines.append(f"- 선호 섹션: {section_text}")
    if tone:
        lines.append(f"- 문체 기준: {tone}")
    if detail_level:
        lines.append(f"- 상세도: {detail_level}")
    return lines


def _context_lines_from_context_template(template: dict) -> list[str]:
    if not isinstance(template, dict):
        return []
    lines = []
    name = str(template.get("name") or "").strip()
    purpose = str(template.get("purpose") or "").strip()
    prompt = str(template.get("prompt") or "").strip()
    focus = template.get("focus") if isinstance(template.get("focus"), list) else []
    if name and str(template.get("id") or "").strip() != "general":
        lines.append(f"- 정리 맥락 제목: {name}")
    if prompt:
        lines.append(f"- 정리 맥락 지시: {prompt}")
    elif purpose and str(template.get("id") or "").strip() != "general":
        lines.append(f"- 정리 맥락 설명: {purpose}")
    focus_text = ", ".join(str(item).strip() for item in focus if str(item).strip())
    if focus_text and str(template.get("id") or "").strip() != "general":
        lines.append(f"- 정리 초점: {focus_text}")
    return lines


def _context_lines_from_glossaries(glossaries: list) -> list[str]:
    if not isinstance(glossaries, list):
        return []
    lines = []
    count = 0
    for glossary in glossaries:
        if not isinstance(glossary, dict):
            continue
        glossary_name = str(glossary.get("name") or glossary.get("category") or "").strip()
        for entry in glossary.get("entries", []) or []:
            if not isinstance(entry, dict) or entry.get("active") is False:
                continue
            canonical = str(entry.get("canonical") or "").strip()
            if not canonical:
                continue
            variants = entry.get("variants") if isinstance(entry.get("variants"), list) else []
            variant_text = ", ".join(str(variant).strip() for variant in variants if str(variant).strip())
            description = str(entry.get("description") or "").strip()
            prefix = f"{glossary_name}: " if glossary_name else ""
            line = f"- {prefix}{canonical}"
            if variant_text:
                line += f" (오인식/변형 후보: {variant_text})"
            if description:
                line += f" - {description}"
            lines.append(line)
            count += 1
            if count >= MAX_CONTEXT_GLOSSARY_ENTRIES:
                return lines
    return lines


def _meeting_context_block(meeting_context: dict | None, *, include_report_template: bool = False) -> str:
    context_lines = []
    if meeting_context:
        title = str(meeting_context.get("title") or "").strip()
        date = str(meeting_context.get("date") or "").strip()
        purpose = str(meeting_context.get("meeting_purpose") or meeting_context.get("purpose") or "").strip()
        if title:
            context_lines.append(f"- 회의 제목: {title}")
        if date:
            context_lines.append(f"- 회의 일시: {date}")
        if purpose:
            context_lines.append(f"- 회의 목적: {purpose}")
        context_lines.extend(_context_lines_from_context_template(meeting_context.get("context_template") or {}))
        if include_report_template:
            context_lines.extend(_context_lines_from_report_template(meeting_context.get("report_template") or {}))
        glossary_lines = _context_lines_from_glossaries(meeting_context.get("term_glossaries") or [])
        if glossary_lines:
            context_lines.append("- 선택 분야별 용어: 아래 용어는 회의 목적/정리 맥락과 함께 표기와 의미 참고용으로 사용하며, 실제 논의 여부는 대화록으로 판단합니다.")
            context_lines.extend(glossary_lines)
    if not context_lines:
        return ""
    return (
        "Meeting context for orientation only:\n"
        + "\n".join(context_lines)
        + "\nUse this context to choose what to emphasize, but if it conflicts with the transcript, trust the transcript. "
        "Do not state context-only information as a confirmed discussion result.\n\n"
    )


def _build_prompt(transcript_text: str, partial: bool = False, meeting_context: dict | None = None) -> str:
    scope = "partial transcript" if partial else "transcript"
    context_block = _meeting_context_block(meeting_context)
    return f"""You are a Korean meeting-minutes assistant.
Summarize the {scope} into strict JSON only. Do not wrap it in Markdown.
Write all JSON values in Korean unless a source term must remain in English.
Do not invent facts. If the transcript is too short or unclear, put that in needs_check.

Required JSON schema:
{{
  "title": "short meeting title",
  "overview": "brief summary",
  "topics": ["topic 1"],
  "decisions": ["decision 1"],
  "actions": ["owner: task"],
  "needs_check": ["unclear item"]
}}

{context_block}
Transcript:
{transcript_text}
"""


def _summary_has_content(summary: dict) -> bool:
    return bool(
        str(summary.get("overview", "")).strip()
        or summary.get("topics")
        or summary.get("topic_sections")
        or summary.get("participant_summaries")
        or summary.get("decisions")
        or summary.get("actions")
    )


def _fallback_extract_summary(transcript_text: str) -> dict:
    compact = re.sub(r"\s+", " ", transcript_text).strip()
    return {
        "title": "회의록",
        "overview": compact[:500] + ("..." if len(compact) > 500 else ""),
        "topics": [],
        "topic_sections": [],
        "participant_summaries": [],
        "decisions": [],
        "actions": [],
        "needs_check": ["LLM 요약 결과가 비어 있어 transcript 앞부분을 임시 개요로 사용했습니다."],
    }


def _generate_summary_once(model_name: str, prompt: str) -> dict:
    result_text = generate_ollama_text(model_name, prompt)
    return _normalize_summary(_parse_llm_json(result_text))


def _generate_json_once(model_name_or_path: str, prompt: str) -> dict | list:
    if not os.path.exists(model_name_or_path) and not is_local_summary_model_path(model_name_or_path):
        return _parse_llm_json(generate_ollama_text(model_name_or_path, prompt))

    if not os.path.exists(model_name_or_path):
        raise failure_for_code("model_missing")

    from llama_cpp import Llama

    llm = Llama(model_path=model_name_or_path, n_ctx=8192, n_gpu_layers=-1, verbose=False)
    response = llm(prompt, max_tokens=2048, stop=["```"], echo=False)
    return _parse_llm_json(response["choices"][0]["text"].strip())


def _segments_to_transcript(transcript_segments: list[dict]) -> str:
    lines = []
    for segment in transcript_segments:
        speaker = segment.get("speaker_name") or segment.get("speaker") or "UNKNOWN"
        text = str(segment.get("text", "")).strip()
        if text:
            lines.append(f"{speaker}: {text}")
    return "\n".join(lines)


def _trim_followup_transcript(transcript_text: str, max_chars: int = 12000) -> str:
    if len(transcript_text) <= max_chars:
        return transcript_text
    half = max_chars // 2
    return f"{transcript_text[:half]}\n...\n{transcript_text[-half:]}"


def _speaker_focused_transcript(
    transcript_segments: list[dict],
    max_chars_per_speaker: int = 3500,
    max_total_chars: int = 12000,
) -> str:
    grouped: dict[str, list[str]] = {}
    for segment in transcript_segments:
        speaker = str(segment.get("speaker_name") or segment.get("speaker") or "UNKNOWN").strip() or "UNKNOWN"
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        grouped.setdefault(speaker, []).append(text)

    blocks = []
    per_speaker_budget = max(800, min(max_chars_per_speaker, max_total_chars // max(1, len(grouped))))
    for speaker, utterances in grouped.items():
        speaker_text = "\n".join(f"- {text}" for text in utterances)
        blocks.append(f"{speaker}\n{_trim_followup_transcript(speaker_text, per_speaker_budget)}")
    return _trim_followup_transcript("\n\n".join(blocks), max_total_chars)


def _normalize_topic_sections(items) -> list[dict]:
    if not isinstance(items, list):
        return []
    sections = []
    for item in items:
        if not isinstance(item, dict):
            continue
        topic = str(item.get("topic") or item.get("title") or item.get("name") or "").strip()
        if not topic:
            continue
        evidence = item.get("evidence", [])
        if isinstance(evidence, str):
            evidence = [evidence]
        actions = item.get("actions", [])
        if isinstance(actions, str):
            actions = [actions]
        sections.append({
            "topic": topic,
            "summary": str(item.get("summary") or item.get("content") or item.get("description") or "").strip(),
            "evidence": evidence if isinstance(evidence, list) else [],
            "actions": actions if isinstance(actions, list) else [],
        })
    return sections


def _topic_sections_from_response(data) -> list[dict]:
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = data.get("topic_sections") or data.get("topicSections") or data.get("sections") or data.get("topics")
    else:
        items = []
    return _normalize_topic_sections(items)


def _fallback_topic_sections_from_response(data) -> list[dict]:
    if not isinstance(data, dict):
        return []

    summary = str(
        data.get("summary")
        or data.get("overview")
        or data.get("content")
        or data.get("description")
        or ""
    ).strip()
    raw_topics = (
        data.get("keywords")
        or data.get("key_topics")
        or data.get("keyTopics")
        or data.get("topics")
        or []
    )
    topic_names = []
    if isinstance(raw_topics, list):
        topic_names = [str(item).strip() for item in raw_topics if not isinstance(item, dict) and str(item).strip()]
    elif isinstance(raw_topics, str) and raw_topics.strip():
        topic_names = [raw_topics.strip()]

    if summary:
        topic = " / ".join(topic_names[:3]) if topic_names else "핵심 주제"
        return [{
            "topic": topic,
            "summary": summary,
            "evidence": topic_names,
            "actions": [],
        }]

    return [
        {
            "topic": topic,
            "summary": "",
            "evidence": [],
            "actions": [],
        }
        for topic in topic_names
    ]


def _normalize_speaker_context_summaries(items) -> list[dict]:
    if not isinstance(items, list):
        return []
    summaries = []
    for item in items:
        if not isinstance(item, dict):
            continue
        speaker = str(item.get("speaker") or item.get("participant") or "").strip()
        if not speaker:
            continue
        summaries.append({
            "speaker": speaker,
            "display_name": str(item.get("display_name") or item.get("displayName") or speaker).strip(),
            "role_in_meeting": str(item.get("role_in_meeting") or item.get("roleInMeeting") or "").strip(),
            "summary": str(item.get("summary", "")).strip(),
            "key_points": item.get("key_points", []) if isinstance(item.get("key_points", []), list) else [],
            "actions": item.get("actions", []) if isinstance(item.get("actions", []), list) else [],
            "needs_check": item.get("needs_check", []) if isinstance(item.get("needs_check", []), list) else [],
        })
    return summaries


def _speaker_context_summaries_from_response(data) -> list[dict]:
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = data.get("speaker_context_summaries") or data.get("speakerContextSummaries") or data.get("speakers")
    else:
        items = []
    return _normalize_speaker_context_summaries(items)


def _text_items(value) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item or "").strip()]


def _report_template_section_names(template: dict | None) -> list[str]:
    template_sections = template.get("sections") if isinstance(template, dict) else []
    if not isinstance(template_sections, list):
        return []
    return [str(section).strip() for section in template_sections if str(section or "").strip()]


def _report_section_key(title: str) -> str:
    return re.sub(r"\s+", " ", title).strip().casefold()


def _reference_report_section(unmatched_sections: list[dict]) -> dict | None:
    lines: list[str] = []
    for section in unmatched_sections:
        title = str(section.get("title") or "").strip()
        content = str(section.get("content") or "").strip()
        if not content:
            continue
        if title:
            lines.append(f"{title}\n{content}")
        else:
            lines.append(content)
    if not lines:
        return None
    return {"title": "참고", "content": "\n\n".join(lines)}


def _report_needs_template_retry(report: dict, template: dict | None = None) -> bool:
    if not _report_template_section_names(template):
        return False
    sections = report.get("sections") if isinstance(report, dict) else []
    if not isinstance(sections, list) or not sections:
        return True
    return all(_report_section_key(str(section.get("title") or "")) == _report_section_key("참고") for section in sections if isinstance(section, dict))


def _report_sections_from_response(data, template: dict | None = None) -> list[dict]:
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = (
            data.get("sections")
            or data.get("report_sections")
            or data.get("reportSections")
            or data.get("meeting_report")
            or data.get("meetingReport")
            or []
        )
        if isinstance(items, dict):
            items = items.get("sections") or []
    else:
        items = []

    template_section_names = _report_template_section_names(template)
    sections: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or item.get("section") or item.get("heading") or "").strip()
        raw_content = item.get("content") or item.get("body") or item.get("summary") or ""
        if isinstance(raw_content, list):
            content = "\n".join(_text_items(raw_content)).strip()
        else:
            content = str(raw_content or "").strip()
        if title and content:
            sections.append({"title": title, "content": content})

    if sections:
        if template_section_names:
            template_index_by_key = {
                _report_section_key(title): index
                for index, title in enumerate(template_section_names)
            }
            ordered_slots: list[dict | None] = [None] * len(template_section_names)
            unmatched_sections: list[dict] = []
            for section in sections:
                template_index = template_index_by_key.get(_report_section_key(section["title"]))
                if template_index is not None and ordered_slots[template_index] is None:
                    ordered_slots[template_index] = {
                        "title": template_section_names[template_index],
                        "content": section["content"],
                    }
                else:
                    unmatched_sections.append(section)

            ordered_sections = [section for section in ordered_slots if section is not None]
            reference_section = _reference_report_section(unmatched_sections)
            if reference_section:
                ordered_sections.append(reference_section)
            if ordered_sections:
                return ordered_sections
            if reference_section:
                return [reference_section]
        return sections

    summary_content = ""
    if isinstance(data, dict):
        summary_content = str(data.get("content") or data.get("summary") or data.get("report") or "").strip()
    if summary_content and template_section_names:
        return [
            {"title": template_section_names[0], "content": summary_content}
        ]
    return []


def _meeting_report_from_response(data, template: dict | None = None) -> dict:
    source = data
    if isinstance(data, dict):
        nested = data.get("meeting_report") or data.get("meetingReport")
        if isinstance(nested, dict):
            source = nested
    sections = _report_sections_from_response(source, template)
    content = ""
    if isinstance(source, dict):
        content = str(source.get("content") or source.get("report") or source.get("summary") or "").strip()
    if not content and sections:
        content = "\n\n".join(f"{section['title']}\n{section['content']}" for section in sections)
    if not sections and content:
        sections = [{"title": "보고서", "content": content}]
    return {"content": content, "sections": sections}


def _fallback_speaker_context_from_segments(transcript_segments: list[dict]) -> list[dict]:
    by_speaker: dict[str, dict] = {}
    for segment in transcript_segments:
        speaker = str(segment.get("speaker") or segment.get("speaker_name") or "UNKNOWN").strip() or "UNKNOWN"
        display_name = str(segment.get("speaker_name") or speaker).strip() or speaker
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        entry = by_speaker.setdefault(speaker, {"display_name": display_name, "texts": []})
        entry["texts"].append(text)

    summaries = []
    for speaker, entry in by_speaker.items():
        texts = entry["texts"]
        combined = " ".join(texts)
        summary = combined[:700] + ("..." if len(combined) > 700 else "")
        key_points = [text[:180] + ("..." if len(text) > 180 else "") for text in texts[:3]]
        summaries.append({
            "speaker": speaker,
            "display_name": entry["display_name"],
            "role_in_meeting": "",
            "summary": summary,
            "key_points": key_points,
            "actions": [],
            "needs_check": ["자동 참석자별 정리가 충분하지 않아 원문 발언 기준으로 임시 정리했습니다."],
        })
    return summaries


def generate_meeting_report(
    transcript_segments: list[dict],
    base_summary: dict,
    topic_sections: list[dict] | None = None,
    speaker_context_summaries: list[dict] | None = None,
    report_template: dict | None = None,
    model_name_or_path: str = "./models/llm/gemma.gguf",
    meeting_context: dict | None = None,
) -> dict:
    transcript_text = _segments_to_transcript(transcript_segments)
    if not transcript_text.strip():
        return {}

    template = report_template if isinstance(report_template, dict) else {}
    section_names = _report_template_section_names(template)
    if not section_names:
        section_names = ["회의 개요", "주요 내용", "결정사항", "후속 조치"]

    context_block = _meeting_context_block(meeting_context, include_report_template=True)
    prompt = f"""You are a Korean meeting report assistant.
Create a formal meeting report from the already organized meeting notes.
Use the transcript as source of truth and the organized notes as the main structure.
Apply the report template exactly when possible. Use the required section titles in the same order and do not add unrelated section titles. Do not invent facts.
Return strict JSON only. Do not wrap it in Markdown.
Write all JSON values in Korean unless a source term must remain in English.

{context_block}\
Required JSON schema:
{{
  "content": "complete report text",
  "sections": [
    {{"title": "template section title", "content": "report-ready section body"}}
  ]
}}

Report template:
{json.dumps(template or {}, ensure_ascii=False)}

Required section order:
{json.dumps(section_names, ensure_ascii=False)}
Use these section titles as the final report section titles. Do not add unrelated section titles.

Organized summary:
{json.dumps(base_summary or {}, ensure_ascii=False)}

Topic sections:
{json.dumps(topic_sections or [], ensure_ascii=False)}

Participant context summaries:
{json.dumps(speaker_context_summaries or [], ensure_ascii=False)}

Transcript:
{_trim_followup_transcript(transcript_text, 9000)}
"""
    data = _generate_json_once(model_name_or_path, prompt)
    report = _meeting_report_from_response(data, template)
    if report.get("content") and report.get("sections") and not _report_needs_template_retry(report, template):
        return report

    retry_prompt = f"""Return only valid JSON for a Korean meeting report.
Use exactly these top-level keys: "content" and "sections".
The "sections" array must follow this order:
{json.dumps(section_names, ensure_ascii=False)}
Use these section titles as the final report section titles. Do not add unrelated section titles.

Schema:
{{"content":"", "sections":[{{"title":"", "content":""}}]}}

{context_block}\
Report template:
{json.dumps(template or {}, ensure_ascii=False)}

Organized summary:
{json.dumps(base_summary or {}, ensure_ascii=False)}

Topic sections:
{json.dumps(topic_sections or [], ensure_ascii=False)}

Participant context summaries:
{json.dumps(speaker_context_summaries or [], ensure_ascii=False)}

Transcript:
{_trim_followup_transcript(transcript_text, 7000)}
"""
    retry_data = _generate_json_once(model_name_or_path, retry_prompt)
    return _meeting_report_from_response(retry_data, template)


def generate_topic_sections(
    transcript_segments: list[dict],
    base_summary: dict,
    model_name_or_path: str = "./models/llm/gemma.gguf",
    meeting_context: dict | None = None,
) -> list[dict]:
    transcript_text = _segments_to_transcript(transcript_segments)
    if not transcript_text.strip():
        return []

    context_block = _meeting_context_block(meeting_context)
    prompt = f"""You are a Korean meeting-minutes assistant.
Create 3 to 7 topic-by-topic meeting notes from the transcript and the basic meeting summary.
Do not collapse the whole meeting into a single generic topic such as "핵심 주제".
Return strict JSON only. Do not wrap it in Markdown.
Do not invent facts. Write all JSON values in Korean unless a source term must remain in English.

{context_block}\
Required JSON schema:
{{
  "topic_sections": [
    {{
      "topic": "topic title",
      "summary": "what was discussed about this topic in context",
      "evidence": ["short transcript-based evidence"],
      "actions": ["topic-specific task"]
    }}
  ]
}}

Basic summary:
{json.dumps(base_summary or {}, ensure_ascii=False)}

Transcript:
{_trim_followup_transcript(transcript_text)}
"""
    data = _generate_json_once(model_name_or_path, prompt)
    sections = _reject_generic_single_topic(_topic_sections_from_response(data))
    if sections:
        return sections

    retry_prompt = f"""Return only valid JSON with exactly one top-level key named "topic_sections".
Do not use top-level keys named "summary" or "keywords".
Create 3 to 7 Korean topic sections from this transcript.
Do not return only one broad topic. Split by concrete discussion subjects, decisions, model details, risks, or follow-up work.
Each item must include "topic", "summary", "evidence", and "actions".

{context_block}\
Schema:
{{"topic_sections":[{{"topic":"", "summary":"", "evidence":[], "actions":[]}}]}}

Basic summary:
{json.dumps(base_summary or {}, ensure_ascii=False)}

Transcript:
{_trim_followup_transcript(transcript_text, 8000)}
"""
    retry_data = _generate_json_once(model_name_or_path, retry_prompt)
    sections = _reject_generic_single_topic(_topic_sections_from_response(retry_data))
    if sections:
        return sections
    fallback_sections = _fallback_topic_sections_from_response(retry_data) or _fallback_topic_sections_from_response(data)
    return _reject_generic_single_topic(fallback_sections)


def generate_topic_section_for_title(
    transcript_segments: list[dict],
    base_summary: dict,
    topic_title: str,
    model_name_or_path: str = "./models/llm/gemma.gguf",
    meeting_context: dict | None = None,
) -> dict:
    topic_title = str(topic_title or "").strip()
    if not topic_title:
        return {}

    transcript_text = _segments_to_transcript(transcript_segments)
    if not transcript_text.strip():
        return {}

    topic_title_json = json.dumps(topic_title, ensure_ascii=False)
    context_block = _meeting_context_block(meeting_context)
    prompt = f"""You are a Korean meeting-minutes assistant.
Create one focused topic section for the requested topic title.
Use the transcript as the source of truth. If the requested topic is only partially discussed, summarize the related parts and add uncertainty to evidence or actions.
Return strict JSON only. Do not wrap it in Markdown.
Do not invent facts. Write all JSON values in Korean unless a source term must remain in English.

{context_block}\
Required JSON schema:
{{
  "topic_sections": [
    {{
      "topic": {topic_title_json},
      "summary": "what was discussed about this requested topic",
      "evidence": ["short transcript-based evidence"],
      "actions": ["topic-specific task"]
    }}
  ]
}}

Requested topic title:
{topic_title}

Basic summary:
{json.dumps(base_summary or {}, ensure_ascii=False)}

Transcript:
{_trim_followup_transcript(transcript_text)}
"""
    data = _generate_json_once(model_name_or_path, prompt)
    sections = _topic_sections_from_response(data)
    if sections:
        section = sections[0]
        section["topic"] = topic_title
        return section
    fallback_sections = _fallback_topic_sections_from_response(data)
    if fallback_sections:
        section = fallback_sections[0]
        section["topic"] = topic_title
        return section
    return {}


def generate_speaker_context_summaries(
    transcript_segments: list[dict],
    base_summary: dict,
    topic_sections: list[dict] | None = None,
    model_name_or_path: str = "./models/llm/gemma.gguf",
    meeting_context: dict | None = None,
) -> list[dict]:
    transcript_text = _segments_to_transcript(transcript_segments)
    if not transcript_text.strip():
        return []
    speaker_focused_text = _speaker_focused_transcript(transcript_segments)

    context_block = _meeting_context_block(meeting_context)
    prompt = f"""You are a Korean meeting-minutes assistant.
Create participant-by-participant context summaries from the whole meeting context.
Do not summarize each participant mechanically from isolated utterances. Interpret each participant's comments in relation to the overall discussion, other participants, topics, decisions, and tasks.
Use the participant-focused excerpts to review each participant's comments across the meeting, then use the topic sections and transcript context to avoid losing the overall flow.
Return strict JSON only. Do not wrap it in Markdown.
Use existing participant labels unless a verified participant name is present in the transcript or summary.
Do not invent participant identities. Write all JSON values in Korean unless a source term must remain in English.

{context_block}\
Required JSON schema:
{{
  "speaker_context_summaries": [
    {{
      "speaker": "참석자01",
      "display_name": "참석자01 or verified participant name",
      "role_in_meeting": "observed role in this meeting",
      "summary": "context-aware summary of this participant's contribution",
      "key_points": ["important point in context"],
      "actions": ["participant-related task"],
      "needs_check": ["identity or context item that needs confirmation"]
    }}
  ]
}}

Basic summary:
{json.dumps(base_summary or {}, ensure_ascii=False)}

Topic sections:
{json.dumps(topic_sections or [], ensure_ascii=False)}

Participant-focused excerpts:
{speaker_focused_text}

Transcript context:
{_trim_followup_transcript(transcript_text)}
"""
    data = _generate_json_once(model_name_or_path, prompt)
    summaries = _speaker_context_summaries_from_response(data)
    if summaries:
        return summaries

    retry_prompt = f"""Return only valid JSON with exactly one top-level key named "speaker_context_summaries".
Do not return prose, markdown, or a single general summary.
Create one item per participant label found in the transcript.
Each item must include "speaker", "display_name", "role_in_meeting", "summary", "key_points", "actions", and "needs_check".

{context_block}\
Schema:
{{"speaker_context_summaries":[{{"speaker":"", "display_name":"", "role_in_meeting":"", "summary":"", "key_points":[], "actions":[], "needs_check":[]}}]}}

Basic summary:
{json.dumps(base_summary or {}, ensure_ascii=False)}

Topic sections:
{json.dumps(topic_sections or [], ensure_ascii=False)}

Participant-focused excerpts:
{speaker_focused_text}

Transcript context:
{_trim_followup_transcript(transcript_text, 8000)}
"""
    retry_data = _generate_json_once(model_name_or_path, retry_prompt)
    summaries = _speaker_context_summaries_from_response(retry_data)
    if summaries:
        return summaries
    return _fallback_speaker_context_from_segments(transcript_segments)


def _split_text_for_summary(transcript_text: str, max_chars: int = SUMMARY_CHUNK_CHARS) -> list[str]:
    def split_long_line(line: str) -> list[str]:
        if len(line) <= max_chars:
            return [line]
        parts = []
        remaining = line.strip()
        while len(remaining) > max_chars:
            split_at = remaining.rfind(" ", 0, max_chars)
            if split_at < max_chars // 2:
                split_at = max_chars
            parts.append(remaining[:split_at].strip())
            remaining = remaining[split_at:].strip()
        if remaining:
            parts.append(remaining)
        return [part for part in parts if part]

    lines = [line for line in transcript_text.splitlines() if line.strip()]
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for raw_line in lines:
        for line in split_long_line(raw_line):
            line_len = len(line) + 1
            if current and current_len + line_len > max_chars:
                chunks.append("\n".join(current))
                current = []
                current_len = 0
            current.append(line)
            current_len += line_len

    if current:
        chunks.append("\n".join(current))
    return chunks or [transcript_text]

def _error_summary(
    title: str,
    overview: str,
    status: str = "failed",
    error_code: str = "generation_internal_error",
) -> dict:
    summary = {
        "title": title,
        "overview": overview,
        "topics": [],
        "topic_sections": [],
        "participant_summaries": [],
        "decisions": [],
        "actions": [],
        "needs_check": [],
        "generation_status": {
            "summary": status,
            "topic_sections": "not_started",
            "speaker_context_summaries": "not_started",
        },
    }
    if status == "failed":
        failure = failure_for_code(error_code)
        summary["generation_error_detail"] = failure.code
        summary["generation_error"] = failure.as_detail("summary")
    return summary


def _generation_failure_summary(error: BaseException) -> dict:
    failure = classify_generation_exception(error)
    return _error_summary(
        "회의록 (생성 실패)",
        failure.user_message,
        error_code=failure.code,
    )


def summarize_meeting(
    transcript_segments: list[dict],
    model_name_or_path: str = "./models/llm/gemma.gguf",
    mode: str = "meeting_minutes",
    api_url: str = "",
    meeting_context: dict | None = None,
) -> dict:
    transcript_text = ""
    for segment in transcript_segments:
        speaker = segment.get("speaker_name") or segment.get("speaker") or "UNKNOWN"
        text = segment.get("text", "")
        if text:
            transcript_text += f"{speaker}: {text}\n"

    if not transcript_text.strip():
        return _error_summary("회의록", "요약할 transcript가 없습니다.")

    prompt = _build_prompt(transcript_text, meeting_context=meeting_context)

    if not os.path.exists(model_name_or_path) and not is_local_summary_model_path(model_name_or_path):
        try:
            print(f"[LLM] Generating summary with Ollama model: {model_name_or_path} ...")
            if len(transcript_text) > MAX_DIRECT_SUMMARY_CHARS:
                partial_summaries = []
                for index, chunk in enumerate(_split_text_for_summary(transcript_text), start=1):
                    partial = _generate_summary_once(model_name_or_path, _build_prompt(chunk, partial=True, meeting_context=meeting_context))
                    partial_summaries.append(f"부분 {index}: {json.dumps(partial, ensure_ascii=False)}")
                summary = _generate_summary_once(model_name_or_path, _build_prompt("\n".join(partial_summaries), meeting_context=meeting_context))
            else:
                summary = _generate_summary_once(model_name_or_path, prompt)
            return summary if _summary_has_content(summary) else _fallback_extract_summary(transcript_text)
        except Exception as exc:
            return _generation_failure_summary(exc)

    if not os.path.exists(model_name_or_path):
        failure = failure_for_code("model_missing")
        return _error_summary(
            "회의록 (생성 실패)",
            failure.user_message,
            error_code=failure.code,
        )

    try:
        from llama_cpp import Llama

        print(f"[LLM] Loading internal Llama engine with model: {model_name_or_path} ...")
        llm = Llama(model_path=model_name_or_path, n_ctx=8192, n_gpu_layers=-1, verbose=False)
        print("[LLM] Generating summary locally...")
        response = llm(prompt, max_tokens=2048, stop=["```"], echo=False)
        result_text = response["choices"][0]["text"].strip()
        return _normalize_summary(_parse_llm_json(result_text))
    except Exception as exc:
        return _generation_failure_summary(exc)
