import json
import os
import re
import urllib.error
import urllib.request

from ollama_utils import ensure_ollama_server_running, find_ollama_executable, get_ollama_base_url, ollama_subprocess_env
from process_utils import run_hidden


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


def _build_prompt(transcript_text: str, partial: bool = False, meeting_context: dict | None = None) -> str:
    scope = "partial transcript" if partial else "transcript"
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
    context_block = ""
    if context_lines:
        context_block = (
            "Meeting context for orientation only:\n"
            + "\n".join(context_lines)
            + "\nUse this context to choose what to emphasize, but if it conflicts with the transcript, trust the transcript. "
            "Do not state context-only information as a confirmed discussion result.\n\n"
        )
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


def _generate_with_ollama_http(model_name: str, prompt: str) -> str:
    ensure_ollama_server_running(timeout_seconds=15)
    payload = json.dumps({
        "model": model_name,
        "prompt": prompt,
        "stream": False,
        "format": "json",
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{get_ollama_base_url()}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        data = json.loads(response.read().decode("utf-8"))
    return data.get("response", "")


def _generate_with_ollama_cli(model_name: str, prompt: str) -> str:
    ensure_ollama_server_running(timeout_seconds=15)
    response = run_hidden(
        [find_ollama_executable(), "run", model_name],
        input=prompt,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=ollama_subprocess_env(),
        timeout=600,
    )
    return response.stdout


def _generate_summary_once(model_name: str, prompt: str) -> dict:
    try:
        result_text = _generate_with_ollama_http(model_name, prompt)
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        result_text = _generate_with_ollama_cli(model_name, prompt)
    return _normalize_summary(_parse_llm_json(result_text))


def _generate_json_once(model_name_or_path: str, prompt: str) -> dict | list:
    if not os.path.exists(model_name_or_path) and not model_name_or_path.endswith((".gguf", ".bin")):
        try:
            result_text = _generate_with_ollama_http(model_name_or_path, prompt)
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            result_text = _generate_with_ollama_cli(model_name_or_path, prompt)
        return _parse_llm_json(result_text)

    if not os.path.exists(model_name_or_path):
        raise FileNotFoundError(model_name_or_path)

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


def generate_topic_sections(
    transcript_segments: list[dict],
    base_summary: dict,
    model_name_or_path: str = "./models/llm/gemma.gguf",
) -> list[dict]:
    transcript_text = _segments_to_transcript(transcript_segments)
    if not transcript_text.strip():
        return []

    prompt = f"""You are a Korean meeting-minutes assistant.
Create 3 to 7 topic-by-topic meeting notes from the transcript and the basic meeting summary.
Do not collapse the whole meeting into a single generic topic such as "핵심 주제".
Return strict JSON only. Do not wrap it in Markdown.
Do not invent facts. Write all JSON values in Korean unless a source term must remain in English.

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
) -> dict:
    topic_title = str(topic_title or "").strip()
    if not topic_title:
        return {}

    transcript_text = _segments_to_transcript(transcript_segments)
    if not transcript_text.strip():
        return {}

    topic_title_json = json.dumps(topic_title, ensure_ascii=False)
    prompt = f"""You are a Korean meeting-minutes assistant.
Create one focused topic section for the requested topic title.
Use the transcript as the source of truth. If the requested topic is only partially discussed, summarize the related parts and add uncertainty to evidence or actions.
Return strict JSON only. Do not wrap it in Markdown.
Do not invent facts. Write all JSON values in Korean unless a source term must remain in English.

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
) -> list[dict]:
    transcript_text = _segments_to_transcript(transcript_segments)
    if not transcript_text.strip():
        return []
    speaker_focused_text = _speaker_focused_transcript(transcript_segments)

    prompt = f"""You are a Korean meeting-minutes assistant.
Create participant-by-participant context summaries from the whole meeting context.
Do not summarize each participant mechanically from isolated utterances. Interpret each participant's comments in relation to the overall discussion, other participants, topics, decisions, and tasks.
Use the participant-focused excerpts to review each participant's comments across the meeting, then use the topic sections and transcript context to avoid losing the overall flow.
Return strict JSON only. Do not wrap it in Markdown.
Use existing participant labels unless a verified participant name is present in the transcript or summary.
Do not invent participant identities. Write all JSON values in Korean unless a source term must remain in English.

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

def _error_summary(title: str, overview: str, status: str = "failed") -> dict:
    return {
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

    if not os.path.exists(model_name_or_path) and not model_name_or_path.endswith((".gguf", ".bin")):
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
        except FileNotFoundError:
            return _error_summary(
                "회의록 (생성 실패)",
                "Ollama 실행 파일을 찾을 수 없습니다. Ollama 설치 또는 GGUF 모델 경로 설정이 필요합니다.",
            )
        except json.JSONDecodeError:
            return _error_summary(
                "회의록 (형식 오류)",
                "Ollama 모델이 올바른 JSON 형식으로 응답하지 않았습니다.",
            )
        except Exception as exc:
            return _error_summary("회의록 (생성 실패)", f"Ollama 요약 중 오류가 발생했습니다: {exc}")

    if not os.path.exists(model_name_or_path):
        return _error_summary(
            "회의록 (생성 실패)",
            f"요약 AI 모델 파일을 찾을 수 없습니다: {model_name_or_path}",
        )

    try:
        from llama_cpp import Llama

        print(f"[LLM] Loading internal Llama engine with model: {model_name_or_path} ...")
        llm = Llama(model_path=model_name_or_path, n_ctx=8192, n_gpu_layers=-1, verbose=False)
        print("[LLM] Generating summary locally...")
        response = llm(prompt, max_tokens=2048, stop=["```"], echo=False)
        result_text = response["choices"][0]["text"].strip()
        return _normalize_summary(_parse_llm_json(result_text))
    except json.JSONDecodeError:
        return _error_summary(
            "회의록 (형식 오류)",
            "LLM이 올바른 JSON 형식으로 응답하지 않았습니다.",
        )
    except Exception as exc:
        return _error_summary("회의록 (생성 실패)", f"요약 엔진 구동 중 오류가 발생했습니다: {exc}")
