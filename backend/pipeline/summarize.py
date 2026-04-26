import json
import os
import subprocess
from ollama_utils import find_ollama_executable

def summarize_meeting(
    transcript_segments: list[dict],
    model_name_or_path: str = "./models/llm/gemma.gguf",
    mode: str = "meeting_minutes",
    api_url: str = "" # kept for backward compatibility
) -> dict:
    """
    화자별 원문을 로컬 LLM(llama-cpp-python)에 전달하여 회의록 양식으로 정리한다.
    외부 프로그램(Ollama) 없이 내부망에서 완벽히 오프라인으로 구동된다.
    """
    
    # 1. 원문 텍스트 조립
    transcript_text = ""
    for seg in transcript_segments:
        speaker = seg.get("speaker_name", "UNKNOWN")
        text = seg.get("text", "")
        transcript_text += f"{speaker}: {text}\n"
        
    if not transcript_text.strip():
        return {
            "title": "회의록",
            "overview": "원문이 없어 요약할 수 없습니다.",
            "topics": [], "decisions": [], "actions": [], "needs_check": []
        }

    # 2. 프롬프트 구성
    prompt = f"""당신은 회의록 정리 담당자입니다.
아래 원문은 음성 인식 결과라서 중복, 말더듬, 불완전한 문장이 포함되어 있습니다.

규칙:
1. 원래 의미를 바꾸지 마세요.
2. 없는 내용을 추가하지 마세요.
3. 담당자와 기한은 명확히 언급된 경우만 적으세요.
4. 불확실한 내용은 "확인 필요"로 표시하세요.
5. 결과는 엄격하게 JSON 형식으로만 정리하세요. 다른 설명은 절대 출력하지 마세요.

출력 JSON 형식 예시:
{{
  "title": "회의록",
  "overview": "회의 전체 요약 내용",
  "topics": ["논의사항 1", "논의사항 2"],
  "decisions": ["결정사항 1"],
  "actions": ["할 일 1 (담당자, 기한)"],
  "needs_check": ["확인 필요 1"]
}}

원문:
{transcript_text}

JSON 출력만 반환하세요:
"""

    # 3. Ollama 모델명인 경우 외부 Ollama 런타임 사용
    if not os.path.exists(model_name_or_path) and not model_name_or_path.endswith((".gguf", ".bin")):
        try:
            print(f"[LLM] Generating summary with Ollama model: {model_name_or_path} ...")
            response = subprocess.run(
                [find_ollama_executable(), "run", model_name_or_path, prompt],
                check=True,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=600,
            )
            result_text = response.stdout.strip()
            if result_text.startswith("```json"):
                result_text = result_text[7:]
            if result_text.endswith("```"):
                result_text = result_text[:-3]
            return json.loads(result_text.strip())
        except FileNotFoundError:
            return {
                "title": "회의록 (생성 실패)",
                "overview": "Ollama 실행 파일을 찾을 수 없습니다. Ollama 설치 또는 GGUF 모델 경로 설정이 필요합니다.",
                "topics": [], "decisions": [], "actions": [], "needs_check": []
            }
        except json.JSONDecodeError:
            return {
                "title": "회의록 (형식 오류)",
                "overview": "Ollama 모델이 올바른 JSON 형식으로 응답하지 않았습니다. 다시 시도해 주세요.",
                "topics": [], "decisions": [], "actions": [], "needs_check": []
            }
        except Exception as e:
            return {
                "title": "회의록 (생성 실패)",
                "overview": f"Ollama 요약 중 오류가 발생했습니다: {e}",
                "topics": [], "decisions": [], "actions": [], "needs_check": []
            }

    # 4. GGUF 모델 파일 존재 여부 확인
    if not os.path.exists(model_name_or_path):
        return {
            "title": "회의록 (생성 실패)",
            "overview": f"요약 AI 모델 파일을 찾을 수 없습니다: {model_name_or_path}\n위 경로에 .gguf 파일을 직접 넣어주세요.",
            "topics": [], "decisions": [], "actions": [], "needs_check": []
        }
        
    try:
        from llama_cpp import Llama
        
        print(f"[LLM] Loading internal Llama engine with model: {model_name_or_path} ...")
        # n_ctx를 회의록 전체를 담을 수 있게 충분히 크게 설정
        llm = Llama(model_path=model_name_or_path, n_ctx=8192, n_gpu_layers=-1, verbose=False)
        
        print("[LLM] Generating summary locally...")
        response = llm(
            prompt,
            max_tokens=2048,
            stop=["```"], 
            echo=False
        )
        
        result_text = response['choices'][0]['text'].strip()
        
        # JSON 포맷 안전 장치 (LLM이 앞뒤에 백틱을 붙였을 경우 제거)
        if result_text.startswith("```json"):
            result_text = result_text[7:]
        if result_text.endswith("```"):
            result_text = result_text[:-3]
            
        summary_data = json.loads(result_text.strip())
        return summary_data
        
    except json.JSONDecodeError as e:
        print(f"[LLM] Failed to parse JSON: {result_text}")
        return {
            "title": "회의록 (형식 오류)",
            "overview": "LLM이 올바른 JSON 형식으로 응답하지 않았습니다. 다시 시도해 주세요.",
            "topics": [], "decisions": [], "actions": [], "needs_check": []
        }
    except Exception as e:
        print(f"[LLM] Error processing summary: {e}")
        return {
            "title": "회의록 (생성 실패)",
            "overview": f"요약 엔진 구동 중 오류가 발생했습니다: {e}",
            "topics": [], "decisions": [], "actions": [], "needs_check": []
        }
