import os
import argparse
from huggingface_hub import snapshot_download

def download_huggingface_model(repo_id: str, local_dir: str, token: str = None):
    """
    Hugging Face에서 모델을 로컬 디렉토리로 다운로드합니다.
    """
    print(f"Downloading model '{repo_id}' to '{local_dir}'...")
    os.makedirs(local_dir, exist_ok=True)
    
    # 일부 파일만 다운로드하도록 필터링 가능 (예: PyTorch weights, 설정 파일)
    # allow_patterns=["*.bin", "*.json", "*.txt", "*.model", "*.yaml", "safetensors"]
    
    try:
        snapshot_download(
            repo_id=repo_id,
            local_dir=local_dir,
            local_dir_use_symlinks=False, # 심볼릭 링크 없이 실제 파일 복사 (오프라인 배포를 위해 필수)
            token=token
        )
        print(f"✅ Successfully downloaded '{repo_id}' to '{local_dir}'\n")
    except Exception as e:
        print(f"❌ Failed to download '{repo_id}': {e}\n")

def main():
    parser = argparse.ArgumentParser(description="Download AI models for offline usage.")
    parser.add_argument("--hf-token", type=str, default=None, help="Hugging Face User Access Token (Required for pyannote and some gated models)")
    args = parser.parse_args()

    # 1. STT 모델 다운로드 (Cohere-transcribe 또는 fallback whisper)
    # 현재는 fallback인 faster-whisper 모델을 다운로드하는 예시.
    # faster-whisper는 기본적으로 모델을 캐싱하지만, 명시적 로컬 보관을 위해 huggingface에서 'Systran/faster-whisper-large-v3'를 받을 수 있음.
    # 혹은 CohereLabs 모델을 다운로드.
    cohere_model_id = "CohereLabs/cohere-transcribe-03-2026"
    cohere_local_dir = "./models/stt/cohere-transcribe-03-2026"
    download_huggingface_model(cohere_model_id, cohere_local_dir, token=args.hf_token)

    # Whisper Fallback
    whisper_model_id = "Systran/faster-whisper-large-v3"
    whisper_local_dir = "./models/stt/faster-whisper-large-v3"
    download_huggingface_model(whisper_model_id, whisper_local_dir, token=args.hf_token)

    # 2. 화자 분리 모델 다운로드 (pyannote)
    # pyannote 모델은 Hugging Face에서 라이선스 동의 후 Access Token을 발급받아야 다운로드 가능합니다.
    diarization_model_id = "pyannote/speaker-diarization-3.1"
    diarization_local_dir = "./models/diarization/speaker-diarization-3.1"
    download_huggingface_model(diarization_model_id, diarization_local_dir, token=args.hf_token)

    segmentation_model_id = "pyannote/segmentation-3.0"
    segmentation_local_dir = "./models/segmentation/segmentation-3.0"
    download_huggingface_model(segmentation_model_id, segmentation_local_dir, token=args.hf_token)

    print("🎉 All models downloaded to the './models/' directory.")
    print("Now update 'backend/config.json' to point 'stt_model' and 'diarization_model' to these local directories.")
    print("Example in config.json:")
    print('  "stt_model": "./models/stt/faster-whisper-large-v3"')
    print('  "diarization_model": "./models/diarization/speaker-diarization-3.1"')

if __name__ == "__main__":
    main()
