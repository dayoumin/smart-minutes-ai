import os
import json
import uuid
import sys
from unittest.mock import patch

# Set encoding for stdout to handle potential unicode issues in different terminals
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Mock functions to simulate AI models without needing heavy weights or tokens
def mock_convert_to_wav(input_path, output_path, ffmpeg_path):
    print(f"[Mock] Converted {input_path} to {output_path}")
    # Just create a dummy file to simulate wav output
    with open(output_path, 'w') as f:
        f.write("mock audio data")
    return output_path

def mock_transcribe_audio(wav_path, model_path, language="ko", device="auto", chunk_seconds=30):
    print(f"[Mock] Transcribing audio with {model_path}...")
    return [
        {"start": 0.0, "end": 2.0, "text": "안녕하세요, 오늘 프로젝트 회의 시작하시죠."},
        {"start": 2.5, "end": 4.0, "text": "네, 일정 지연 건에 대해 논의가 필요합니다."},
        {"start": 4.5, "end": 6.0, "text": "디자인 에셋 파일들은 언제 공유되나요?"},
        {"start": 6.5, "end": 8.0, "text": "내일 오후까지 서버에 업로드하겠습니다."}
    ]

def mock_diarize_audio(wav_path, model_path, min_speakers=None, max_speakers=None):
    print(f"[Mock] Diarizing audio with {model_path}...")
    return [
        {"start": 0.0, "end": 2.2, "speaker": "SPEAKER_00"},
        {"start": 2.4, "end": 4.2, "speaker": "SPEAKER_01"},
        {"start": 4.4, "end": 6.1, "speaker": "SPEAKER_02"},
        {"start": 6.3, "end": 8.5, "speaker": "SPEAKER_01"}
    ]

def mock_summarize_meeting(transcript_segments, model_name_or_path="./models/llm/gemma.gguf", mode="meeting_minutes"):
    print(f"[Mock] Summarizing meeting with {model_name_or_path}...")
    return {
        "title": "프로젝트 일정 및 디자인 에셋 회의",
        "overview": "프로젝트 일정 지연 및 디자인 에셋 공유 일정에 대해 논의함.",
        "topics": ["일정 지연 현황", "디자인 에셋 공유 일정"],
        "decisions": ["디자인 에셋은 내일 오후까지 서버에 업로드하기로 결정됨."],
        "actions": ["디자인 에셋 업로드 (SPEAKER_01, 내일 오후)"],
        "needs_check": ["일정 지연에 대한 구체적 대응 방안"]
    }

@patch('pipeline.audio_preprocess.convert_to_wav', side_effect=mock_convert_to_wav)
@patch('pipeline.transcribe.transcribe_audio', side_effect=mock_transcribe_audio)
@patch('pipeline.diarize.diarize_audio', side_effect=mock_diarize_audio)
@patch('pipeline.summarize.summarize_meeting', side_effect=mock_summarize_meeting)
def run_simulation(mock_summary, mock_diarize, mock_transcribe, mock_convert):
    print("=== STARTING FULL PIPELINE SIMULATION ===")
    
    # Import main after patching
    import main
    
    # Create a dummy source file for the test
    test_input = "test_audio_source.wav"
    with open(test_input, 'w') as f:
        f.write("mock source audio")
        
    job_id = "test_job_" + str(uuid.uuid4())[:8]
    
    try:
        results = main.process_audio_pipeline(test_input, job_id)
        
        print("\n=== SIMULATION RESULTS ===")
        print(f"Success: {results['success']}")
        
        print(f"Output Markdown: {results['md_file']}")
        print(f"Output DOCX: {results['docx_file']}")
        print(f"Output JSON: {results['json_file']}")
        
        # Read and print the generated markdown to verify
        print("\n--- Generated Markdown Preview ---")
        with open(results["md_file"], 'r', encoding='utf-8') as f:
            print(f.read())
        print("----------------------------------\n")
            
        print("Pipeline simulation completed successfully!")
    except Exception as e:
        print(f"Pipeline simulation failed: {str(e)}")
    finally:
        # Cleanup
        if os.path.exists(test_input):
            os.remove(test_input)

if __name__ == "__main__":
    run_simulation()
