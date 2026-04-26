import os
import json
import shutil
from datetime import datetime
from typing import Dict
from fastapi import FastAPI, UploadFile, File, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

# Import the core pipeline logic
from main import process_audio_pipeline, BASE_DIR

app = FastAPI(title="Local Meeting AI - Sidecar API")

# 메모리 기반 간단한 상태 저장소 (실제 운영 시에는 SQLite나 JSON 파일로 관리)
JOBS: Dict[str, dict] = {}

def load_config(config_path: str = "config.json") -> dict:
    full_path = os.path.join(BASE_DIR, config_path)
    with open(full_path, "r", encoding="utf-8") as f:
        return json.load(f)

def run_pipeline(input_file: str, job_id: str, config: dict):
    try:
        JOBS[job_id]["status"] = "processing"
        
        def update_progress(step_name: str, progress_percent: int):
            JOBS[job_id]["step"] = step_name
            JOBS[job_id]["progress"] = progress_percent
            
        # Re-use the unified CLI/API pipeline
        process_audio_pipeline(input_file, job_id, config, progress_callback=update_progress)
        
        # Cleanup original upload file if required (pipeline cleans up temp wav)
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
