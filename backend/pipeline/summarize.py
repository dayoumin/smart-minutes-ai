import json
import os
import re
import subprocess
import urllib.error
import urllib.request

from ollama_utils import find_ollama_executable


EMPTY_SUMMARY = {
    "title": "회의록",
    "overview": "",
    "topics": [],
    "decisions": [],
    "actions": [],
    "needs_check": [],
}

MAX_DIRECT_SUMMARY_CHARS = 8000
SUMMARY_CHUNK_CHARS = 6000


def _parse_llm_json(result_text: str) -> dict:
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
        if char != "{":
            continue
        try:
            parsed, _end = decoder.raw_decode(text[index:])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue
    raise json.JSONDecodeError("No JSON object found in LLM response", text, 0)


def _normalize_summary(data: dict) -> dict:
    summary = dict(EMPTY_SUMMARY)
    if isinstance(data, dict):
        summary.update({key: data.get(key, summary[key]) for key in summary})
    for key in ("topics", "decisions", "actions", "needs_check"):
        if not isinstance(summary[key], list):
            summary[key] = [str(summary[key])] if summary[key] else []
    return summary


def _build_prompt(transcript_text: str, partial: bool = False) -> str:
    scope = "partial transcript" if partial else "transcript"
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

Transcript:
{transcript_text}
"""


def _summary_has_content(summary: dict) -> bool:
    return bool(
        str(summary.get("overview", "")).strip()
        or summary.get("topics")
        or summary.get("decisions")
        or summary.get("actions")
    )


def _fallback_extract_summary(transcript_text: str) -> dict:
    compact = re.sub(r"\s+", " ", transcript_text).strip()
    return {
        "title": "회의록",
        "overview": compact[:500] + ("..." if len(compact) > 500 else ""),
        "topics": [],
        "decisions": [],
        "actions": [],
        "needs_check": ["LLM 요약 결과가 비어 있어 transcript 앞부분을 임시 개요로 사용했습니다."],
    }


def _generate_with_ollama_http(model_name: str, prompt: str) -> str:
    payload = json.dumps({
        "model": model_name,
        "prompt": prompt,
        "stream": False,
        "format": "json",
    }).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:11434/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        data = json.loads(response.read().decode("utf-8"))
    return data.get("response", "")


def _generate_with_ollama_cli(model_name: str, prompt: str) -> str:
    response = subprocess.run(
        [find_ollama_executable(), "run", model_name],
        input=prompt,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=600,
    )
    return response.stdout


def _generate_summary_once(model_name: str, prompt: str) -> dict:
    try:
        result_text = _generate_with_ollama_http(model_name, prompt)
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        result_text = _generate_with_ollama_cli(model_name, prompt)
    return _normalize_summary(_parse_llm_json(result_text))


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

def _error_summary(title: str, overview: str) -> dict:
    return {
        "title": title,
        "overview": overview,
        "topics": [],
        "decisions": [],
        "actions": [],
        "needs_check": [],
    }


def summarize_meeting(
    transcript_segments: list[dict],
    model_name_or_path: str = "./models/llm/gemma.gguf",
    mode: str = "meeting_minutes",
    api_url: str = "",
) -> dict:
    transcript_text = ""
    for segment in transcript_segments:
        speaker = segment.get("speaker_name") or segment.get("speaker") or "UNKNOWN"
        text = segment.get("text", "")
        if text:
            transcript_text += f"{speaker}: {text}\n"

    if not transcript_text.strip():
        return _error_summary("회의록", "요약할 transcript가 없습니다.")

    prompt = _build_prompt(transcript_text)

    if not os.path.exists(model_name_or_path) and not model_name_or_path.endswith((".gguf", ".bin")):
        try:
            print(f"[LLM] Generating summary with Ollama model: {model_name_or_path} ...")
            if len(transcript_text) > MAX_DIRECT_SUMMARY_CHARS:
                partial_summaries = []
                for index, chunk in enumerate(_split_text_for_summary(transcript_text), start=1):
                    partial = _generate_summary_once(model_name_or_path, _build_prompt(chunk, partial=True))
                    partial_summaries.append(f"부분 {index}: {json.dumps(partial, ensure_ascii=False)}")
                summary = _generate_summary_once(model_name_or_path, _build_prompt("\n".join(partial_summaries)))
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
