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


def _build_prompt(transcript_text: str) -> str:
    return f"""You are a meeting-minutes assistant.
Summarize the transcript into strict JSON only. Do not wrap it in Markdown.
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
        [find_ollama_executable(), "run", model_name, prompt],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=600,
    )
    return response.stdout


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
            try:
                result_text = _generate_with_ollama_http(model_name_or_path, prompt)
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                result_text = _generate_with_ollama_cli(model_name_or_path, prompt)
            return _normalize_summary(_parse_llm_json(result_text))
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
