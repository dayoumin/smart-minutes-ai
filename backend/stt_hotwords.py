import hashlib
import json
from pathlib import Path


def normalize_stt_hotwords(value: object) -> list[str]:
    if not isinstance(value, list) or len(value) > 30:
        raise ValueError("주요 용어는 최대 30개까지 적용할 수 있습니다.")
    terms: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError("주요 용어는 글자로 입력해 주세요.")
        term = " ".join(item.split())
        if len(term) > 40 or (term and not term.isprintable()):
            raise ValueError("주요 용어는 한 항목에 일반 문자 40자까지 입력할 수 있습니다.")
        if term and term not in terms:
            terms.append(term)
    return terms


def stt_hotwords_fingerprint(terms: list[str]) -> str:
    if not terms:
        return ""
    payload = json.dumps(["whisper-hotwords-v1", terms], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def format_stt_hotwords(terms: list[str]) -> str:
    return ", ".join(terms)


def validate_stt_hotword_budget(terms: list[str], model_path: str) -> None:
    from tokenizers import Tokenizer

    tokenizer_file = Path(model_path) / "tokenizer.json"
    if not tokenizer_file.is_file():
        raise ValueError("주요 용어를 적용하려면 음성 인식 모델을 준비해 주세요.")
    tokenizer = Tokenizer.from_file(str(tokenizer_file))
    # faster-whisper v1.2.1 truncates this input at half the 448-token
    # decoder context minus one. Reject before saving any analysis progress.
    tokens = tokenizer.encode(" " + format_stt_hotwords(terms), add_special_tokens=False)
    if len(tokens.ids) > 223:
        raise ValueError("주요 용어가 너무 깁니다. 목록의 용어 수나 길이를 줄여 주세요.")
