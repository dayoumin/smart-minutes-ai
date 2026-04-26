import argparse
import os
import json
from datetime import datetime
from pipeline.audio_preprocess import convert_to_wav
from pipeline.transcribe import transcribe_audio
from pipeline.export_txt import export_txt, save_result_json
from pipeline.diarize import diarize_audio
from pipeline.align_speakers import align_segments_with_speakers
from pipeline.summarize import summarize_meeting
from pipeline.export_docx import export_docx
from pipeline.export_markdown import export_markdown

def load_config(config_path: str = "config.json") -> dict:
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)

def process_audio_pipeline(input_file: str, job_id: str = None, config: dict = None) -> dict:
    if config is None:
        config = load_config()
        
    output_dir = config["paths"]["output_dir"]
    temp_dir = config["paths"]["temp_dir"]
    
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(temp_dir, exist_ok=True)
    
    if not job_id:
        base_name = os.path.splitext(os.path.basename(input_file))[0]
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        job_id = f"{timestamp}_{base_name}"
    
    temp_wav_path = os.path.join(temp_dir, f"{job_id}.wav")
    out_json_path = os.path.join(output_dir, f"{job_id}_result.json")
    out_txt_path = os.path.join(output_dir, f"{job_id}_transcript.txt")
    out_md_path = os.path.join(output_dir, f"{job_id}_report.md")
    out_docx_path = os.path.join(output_dir, f"{job_id}_report.docx")

    print(f"--- Local Meeting AI Pipeline ---")
    print(f"Input: {input_file}")
    
    # 1. Convert to WAV
    print(f"[1/5] Converting to 16kHz mono WAV...")
    convert_to_wav(input_file, temp_wav_path, config["paths"]["ffmpeg"])
    
    # 2. STT (Transcribe)
    print(f"[2/5] Transcribing audio...")
    stt_model_path = config["paths"]["stt_model"]
    segments = transcribe_audio(temp_wav_path, stt_model_path)
    
    # 3. Diarization (Optional)
    if config.get("diarization", {}).get("enabled", True):
        print(f"[3/5] Speaker Diarization & Alignment...")
        diarize_model_path = config["paths"]["diarization_model"]
        min_spk = config["diarization"].get("min_speakers")
        max_spk = config["diarization"].get("max_speakers")
        
        spk_segments = diarize_audio(temp_wav_path, diarize_model_path, min_spk, max_spk)
        segments = align_segments_with_speakers(segments, spk_segments)
    else:
        print(f"[3/5] Speaker Diarization disabled. Skipping.")
    
    # 4. Summary (Optional)
    summary_data = {}
    if config.get("summary", {}).get("enabled", True):
        print(f"[4/5] Summarizing with Local LLM...")
        llm_model = config["summary"].get("model", "gemma-4b")
        summary_data = summarize_meeting(segments, model_name_or_path=llm_model)
    else:
        print(f"[4/5] Summarization disabled. Skipping.")
    
    # 5. Save Results
    print(f"[5/5] Saving results...")
    result_data = {
        "job_id": job_id,
        "source_file": os.path.basename(input_file),
        "created_at": datetime.now().isoformat(),
        "language": config["stt"]["language"],
        "settings": {
            "stt_model": stt_model_path,
            "diarization_model": config["paths"].get("diarization_model"),
            "llm_model": config["paths"].get("llm_model"),
            "diarization": config.get("diarization", {}).get("enabled", True),
            "summary": config.get("summary", {}).get("enabled", True)
        },
        "segments": segments,
        "summary": summary_data
    }
    
    save_result_json(result_data, out_json_path)
    export_txt(segments, out_txt_path)
    
    if summary_data:
        # FUTURE HOOK (HWPX Export): 
        # config["export_templates"]["use_custom_template"] 가 true일 경우, 
        # 여기서 export_hwpx(result_data, template_path)를 호출하도록 리팩토링하세요.
        export_markdown(result_data, out_md_path)
        export_docx(result_data, out_docx_path)
    
    # Cleanup temp wav
    if config["privacy"].get("auto_delete_temp_audio", True):
        if os.path.exists(temp_wav_path):
            os.remove(temp_wav_path)
            
    return {
        "success": True,
        "job_id": job_id,
        "json_file": out_json_path,
        "txt_file": out_txt_path,
        "md_file": out_md_path if summary_data else None,
        "docx_file": out_docx_path if summary_data else None,
        "result_data": result_data
    }

def main():
    parser = argparse.ArgumentParser(description="Local Meeting AI - CLI MVP")
    parser.add_argument("--input", required=True, help="Input audio/video file path")
    parser.add_argument("--mode", default="standard", help="Processing mode: fast, standard, accurate")
    args = parser.parse_args()

    results = process_audio_pipeline(args.input)
    
    print(f"Done! Results saved in outputs/")
    print(f" - JSON: {results['json_file']}")
    print(f" - TXT: {results['txt_file']}")
    if results['md_file']:
        print(f" - MD: {results['md_file']}")
        print(f" - DOCX: {results['docx_file']}")


if __name__ == "__main__":
    main()
