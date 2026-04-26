import ffmpeg
import os
import shutil

def convert_to_wav(input_path: str, output_path: str, ffmpeg_path: str = "ffmpeg") -> str:
    """
    입력 음성/영상 파일을 16kHz mono wav로 변환한다.
    """
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input file not found: {input_path}")
        
    # ffmpeg 실행 가능 여부 사전 점검
    if not shutil.which(ffmpeg_path) and not os.path.exists(ffmpeg_path):
        raise FileNotFoundError(
            f"ffmpeg를 찾을 수 없습니다. (경로: {ffmpeg_path})\n"
            "시스템 PATH에 등록되어 있거나, config.json에 정확한 exe 경로가 지정되어야 합니다."
        )
    
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    try:
        # ffmpeg 명령어: -y (덮어쓰기), -ac 1 (mono), -ar 16000 (16kHz)
        stream = ffmpeg.input(input_path)
        stream = ffmpeg.output(stream, output_path, ac=1, ar=16000)
        
        # ffmpeg_path를 지정하여 실행 가능 (기본값은 환경 변수의 ffmpeg)
        cmd = ffmpeg.compile(stream, cmd=ffmpeg_path, overwrite_output=True)
        ffmpeg.run(stream, cmd=ffmpeg_path, overwrite_output=True, capture_stdout=True, capture_stderr=True)
        return output_path
    except ffmpeg.Error as e:
        error_message = e.stderr.decode('utf-8', errors='replace') if e.stderr else "Unknown error"
        raise RuntimeError(f"ffmpeg conversion failed: {error_message}")
