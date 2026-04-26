import os
import argparse

from model_manager import MODEL_SPECS, download_model, get_model_status

def main():
    parser = argparse.ArgumentParser(description="Download AI models for offline usage.")
    parser.add_argument("--hf-token", type=str, default=None, help="Hugging Face User Access Token (Required for pyannote and some gated models)")
    args = parser.parse_args()
    base_dir = os.path.dirname(os.path.abspath(__file__))

    for spec in MODEL_SPECS:
        if not spec.repo_id:
            print(f"⚠️  {spec.label}은 자동 다운로드 대상이 아닙니다. 직접 배치하세요: {spec.local_dir}")
            continue
        if spec.gated and not args.hf_token:
            print(f"⚠️  {spec.label}은 Hugging Face 토큰/라이선스 동의가 필요할 수 있습니다.")
        try:
            target = download_model(base_dir, spec, token=args.hf_token)
            print(f"✅ {spec.label} 준비 완료: {target}")
        except Exception as e:
            print(f"❌ {spec.label} 다운로드 실패: {e}")

    print("🎉 All models downloaded to the './models/' directory.")
    print(get_model_status(base_dir))
    print("Now update 'backend/config.json' to point 'stt_model' and 'diarization_model' to these local directories.")
    print("Example in config.json:")
    print('  "stt_model": "./models/stt/faster-whisper-large-v3"')
    print('  "diarization_model": "./models/diarization/speaker-diarization-community-1"')

if __name__ == "__main__":
    main()
