import os
import json
import shutil
from datetime import datetime
from typing import Dict
from fastapi import FastAPI, UploadFile, File, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from pipeline.audio_preprocess import convert_to_wav
from pipeline.transcribe import transcribe_audio
from pipeline.export_txt import export_txt, save_result_json
from pipeline.diarize import diarize_audio
from pipeline.align_speakers import align_segments_with_speakers
from pipeline.summarize import summarize_meeting
from pipeline.export_docx import export_docx
from pipeline.export_markdown import export_markdown

app = FastAPI(title="Local Meeting AI - Sidecar API")

# 메모리 기반 간단한 상태 저장소 (실제 운영 시에는 SQLite나 JSON 파일로 관리)
JOBS: Dict[str, dict] = {}

def load_config(config_path: str = "config.json") -> dict:
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)

def run_pipeline(input_file: str, job_id: str, config: dict):
    try:
        output_dir = config["paths"]["output_dir"]
        temp_dir = config["paths"]["temp_dir"]
        os.makedirs(output_dir, exist_ok=True)
        os.makedirs(temp_dir, exist_ok=True)
        
        temp_wav_path = os.path.join(temp_dir, f"{job_id}.wav")
        out_json_path = os.path.join(output_dir, f"{job_id}_result.json")
        out_txt_path = os.path.join(output_dir, f"{job_id}_transcript.txt")
        out_md_path = os.path.join(output_dir, f"{job_id}_report.md")
        out_docx_path = os.path.join(output_dir, f"{job_id}_report.docx")

        JOBS[job_id]["status"] = "processing"
        
        # 1. Convert to WAV
        JOBS[job_id]["step"] = "Converting to WAV..."
        JOBS[job_id]["progress"] = 10
        convert_to_wav(input_file, temp_wav_path, config["paths"]["ffmpeg"])
        
        # 2. STT (Transcribe)
        JOBS[job_id]["step"] = "Transcribing audio..."
        JOBS[job_id]["progress"] = 30
        stt_model_path = config["paths"]["stt_model"]
        segments = transcribe_audio(temp_wav_path, stt_model_path)
        
        # 3. Diarization
        if config.get("diarization", {}).get("enabled", True):
            JOBS[job_id]["step"] = "Speaker Diarization & Alignment..."
            JOBS[job_id]["progress"] = 60
            diarize_model_path = config["paths"]["diarization_model"]
            min_spk = config["diarization"].get("min_speakers")
            max_spk = config["diarization"].get("max_speakers")
            
            spk_segments = diarize_audio(temp_wav_path, diarize_model_path, min_spk, max_spk)
            segments = align_segments_with_speakers(segments, spk_segments)
            
        # 4. Summary
        summary_data = {}
        if config.get("summary", {}).get("enabled", True):
            JOBS[job_id]["step"] = "Summarizing with Local LLM..."
            JOBS[job_id]["progress"] = 80
            llm_model = config["summary"].get("model", "gemma-4b")
            summary_data = summarize_meeting(segments, model_name_or_path=llm_model)
            
        # 5. Save Results
        JOBS[job_id]["step"] = "Saving results..."
        JOBS[job_id]["progress"] = 90
        
        result_data = {
            "job_id": job_id,
            "source_file": os.path.basename(input_file),
            "created_at": datetime.now().isoformat(),
            "language": config["stt"]["language"],
            "segments": segments,
            "summary": summary_data
        }
        
        save_result_json(result_data, out_json_path)
        export_txt(segments, out_txt_path)
        if summary_data:
            export_markdown(result_data, out_md_path)
            export_docx(result_data, out_docx_path)
            
        # Cleanup
        if config["privacy"].get("auto_delete_temp_audio", True):
            if os.path.exists(temp_wav_path):
                os.remove(temp_wav_path)
            if not config["privacy"].get("save_original_audio_copy", False):
                if os.path.exists(input_file):
                    os.remove(input_file)
                
        JOBS[job_id]["status"] = "completed"
        JOBS[job_id]["step"] = "Done"
        JOBS[job_id]["progress"] = 100
        
    except Exception as e:
        JOBS[job_id]["status"] = "error"
        JOBS[job_id]["error"] = str(e)
        JOBS[job_id]["step"] = "Error occurred"

@app.post("/api/upload")
async def upload_audio(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    config = load_config()
    temp_dir = config["paths"]["temp_dir"]
    os.makedirs(temp_dir, exist_ok=True)
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base_name = os.path.splitext(file.filename)[0]
    job_id = f"{timestamp}_{base_name}"
    
    # Save uploaded file
    file_path = os.path.join(temp_dir, f"{job_id}_original{os.path.splitext(file.filename)[1]}")
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    JOBS[job_id] = {
        "job_id": job_id,
        "filename": file.filename,
        "status": "pending",
        "progress": 0,
        "step": "Queued",
        "error": None
    }
    
    # Start background task
    background_tasks.add_task(run_pipeline, file_path, job_id, config)
    
    return {"job_id": job_id, "message": "Job started successfully"}

@app.get("/api/status/{job_id}")
async def get_status(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found")
    return JOBS[job_id]

@app.get("/api/result/{job_id}")
async def get_result(job_id: str):
    config = load_config()
    output_dir = config["paths"]["output_dir"]
    json_path = os.path.join(output_dir, f"{job_id}_result.json")
    
    if not os.path.exists(json_path):
        raise HTTPException(status_code=404, detail="Result JSON not found")
        
    with open(json_path, "r", encoding="utf-8") as f:
        return json.load(f)

@app.get("/api/download/{job_id}/{fmt}")
async def download_file(job_id: str, fmt: str):
    config = load_config()
    output_dir = config["paths"]["output_dir"]
    
    if fmt == "txt":
        file_path = os.path.join(output_dir, f"{job_id}_transcript.txt")
    elif fmt == "md":
        file_path = os.path.join(output_dir, f"{job_id}_report.md")
    elif fmt == "docx":
        file_path = os.path.join(output_dir, f"{job_id}_report.docx")
    else:
        raise HTTPException(status_code=400, detail="Invalid format")
        
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    return FileResponse(file_path, filename=os.path.basename(file_path))

if __name__ == "__main__":
    import uvicorn
    # 데스크탑 앱 사이드카는 로컬 호스트 특정 포트에서 동작해야 함
    uvicorn.run(app, host="127.0.0.1", port=8000)
