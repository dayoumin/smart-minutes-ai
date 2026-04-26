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

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def load_config(config_path: str = "config.json") -> dict:
    # Resolve relative to script location for sidecar stability
    full_path = os.path.join(BASE_DIR, config_path)
    with open(full_path, "r", encoding="utf-8") as f:
        return json.load(f)

def process_audio_pipeline(input_file: str, job_id: str = None, config: dict = None, progress_callback=None) -> dict:
    if config is None:
        config = load_config()
        
    def _report_progress(step: str, prog: int):
        print(f"[{prog}%] {step}")
        if progress_callback:
            progress_callback(step, prog)

    out_dir_raw = config["paths"]["output_dir"]
    output_dir = out_dir_raw if os.path.isabs(out_dir_raw) else os.path.normpath(os.path.join(BASE_DIR, out_dir_raw))

    temp_dir_raw = config["paths"]["temp_dir"]
    temp_dir = temp_dir_raw if os.path.isabs(temp_dir_raw) else os.path.normpath(os.path.join(BASE_DIR, temp_dir_raw))
    
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
    _report_progress("Converting to WAV...", 10)
    # ffmpeg path is safe to leave as-is if it's "ffmpeg" (system path), otherwise resolve
    ffmpeg_path = config["paths"]["ffmpeg"]
    if not ffmpeg_path.lower() == "ffmpeg" and not os.path.isabs(ffmpeg_path):
        ffmpeg_path = os.path.normpath(os.path.join(BASE_DIR, ffmpeg_path))
    convert_to_wav(input_file, temp_wav_path, ffmpeg_path)
    
    # 2. STT (Transcribe)
    _report_progress("Transcribing audio...", 30)
    stt_model_path = config["paths"]["stt_model"]
    # If stt_model_path looks like a local relative path, resolve it
    if stt_model_path.startswith((".", "..")):
        stt_model_path = os.path.normpath(os.path.join(BASE_DIR, stt_model_path))
    segments = transcribe_audio(temp_wav_path, stt_model_path)
    
    # 3. Diarization (Optional)
    if config.get("diarization", {}).get("enabled", True):
        _report_progress("Speaker Diarization & Alignment...", 60)
        diarize_model_path = config["paths"]["diarization_model"]
        if diarize_model_path and diarize_model_path.startswith((".", "..")):
            diarize_model_path = os.path.normpath(os.path.join(BASE_DIR, diarize_model_path))
        min_spk = config["diarization"].get("min_speakers")
        max_spk = config["diarization"].get("max_speakers")
        
        spk_segments = diarize_audio(temp_wav_path, diarize_model_path, min_spk, max_spk)
        segments = align_segments_with_speakers(segments, spk_segments)
    
    # 4. Summary (Optional)
    summary_data = {}
    if config.get("summary", {}).get("enabled", True):
        _report_progress("Summarizing with Local LLM...", 80)
        llm_model = config["summary"].get("model", "gemma-4b")
        if llm_model and llm_model.startswith((".", "..")):
            llm_model = os.path.normpath(os.path.join(BASE_DIR, llm_model))
        summary_data = summarize_meeting(segments, model_name_or_path=llm_model)
    
    # 5. Save Results
    _report_progress("Saving results...", 90)
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
