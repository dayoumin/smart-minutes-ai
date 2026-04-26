import React, { useState } from 'react';
import { UploadCloud, FileAudio, Settings, Play, CheckCircle } from 'lucide-react';
import { Card, Button, ProgressBar } from './components/ui';
import './App.css';

function App() {
  const [file, setFile] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('대기 중...');
  const [logs, setLogs] = useState([]);
  const [jobId, setJobId] = useState(null);
  const [result, setResult] = useState(null);

  const API_BASE = 'http://127.0.0.1:8000/api';

  const addLog = (msg) => {
    setLogs(prev => [
      { id: Date.now(), time: new Date().toLocaleTimeString(), message: msg },
      ...prev.slice(0, 19) // Keep last 20 logs
    ]);
  };

  const handleFileDrop = (e) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) {
      setFile(droppedFile);
      addLog(`파일 선택됨: ${droppedFile.name}`);
    }
  };

  const handleFileSelect = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      addLog(`파일 선택됨: ${selectedFile.name}`);
    }
  };

  const pollStatus = async (currentJobId) => {
    try {
      const res = await fetch(`${API_BASE}/status/${currentJobId}`);
      if (!res.ok) return;
      const data = await res.json();
      
      setProgress(data.progress || 0);
      
      if (data.step && data.step !== statusText) {
        setStatusText(data.step);
        addLog(data.step);
      }
      
      if (data.status === 'completed') {
        setIsProcessing(false);
        setJobId(currentJobId);
        addLog('모든 처리가 완료되었습니다.');
        
        // 결과 데이터 가져오기
        const resJson = await fetch(`${API_BASE}/result/${currentJobId}`);
        if(resJson.ok) {
           setResult(await resJson.json());
        }
      } else if (data.status === 'error') {
        setIsProcessing(false);
        setStatusText(`오류 발생: ${data.error}`);
        addLog(`에러 발생: ${data.error}`);
      } else {
        setTimeout(() => pollStatus(currentJobId), 1000);
      }
    } catch (err) {
      console.error("Polling error", err);
      setTimeout(() => pollStatus(currentJobId), 2000);
    }
  };

  const startProcessing = async () => {
    if (!file) return;
    setIsProcessing(true);
    setProgress(0);
    setStatusText('파일 업로드 중...');
    setLogs([{ id: 'init', time: new Date().toLocaleTimeString(), message: '작업 시작' }]);
    setJobId(null);
    setResult(null);
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const response = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        body: formData,
      });
      
      if (!response.ok) throw new Error('업로드 실패');
      
      const data = await response.json();
      addLog('업로드 완료. 파이프라인이 시작되었습니다.');
      pollStatus(data.job_id);
    } catch (error) {
      setStatusText(`오류: ${error.message}`);
      addLog(`치명적 오류: ${error.message}`);
      setIsProcessing(false);
    }
  };

  const downloadFile = (fmt) => {
    if(!jobId) return;
    window.location.href = `${API_BASE}/download/${jobId}/${fmt}`;
  };

  return (
    <div className="app-layout">
      {/* Header */}
      <header className="app-header">
        <div className="logo-area">
          <div className="logo-icon"><FileAudio size={24} color="var(--accent-primary)"/></div>
          <h1>Local Meeting AI</h1>
        </div>
        <div className="header-actions">
           {isProcessing && <div className="pulse-loader"></div>}
           <Button variant="secondary" icon={Settings}>설정</Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="app-main">
        <div className="content-grid">
          
          {/* Left Column: Upload & Controls */}
          <div className="control-panel">
            <Card className="upload-card">
              <div className="card-header">
                <h2>파일 업로드</h2>
                {file && <span className="file-badge">준비됨</span>}
              </div>
              <div 
                className={`drop-zone ${file ? 'has-file' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleFileDrop}
              >
                <input 
                  type="file" 
                  id="file-upload" 
                  accept="audio/*,video/*"
                  onChange={handleFileSelect}
                  hidden 
                />
                <label htmlFor="file-upload" className="drop-content">
                  {file ? (
                    <>
                      <FileAudio size={42} className="text-accent" />
                      <div className="file-info-text">
                        <h3>{file.name}</h3>
                        <p>{(file.size / 1024 / 1024).toFixed(1)} MB</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <UploadCloud size={48} className="text-muted" />
                      <h3>파일을 선택하거나 드래그하세요</h3>
                      <p>MP3, WAV, M4A, MP4</p>
                    </>
                  )}
                </label>
              </div>
            </Card>

            <Card className="logs-card">
              <div className="card-header">
                <h2>실시간 로그</h2>
              </div>
              <div className="log-list">
                {logs.length === 0 ? (
                  <p className="empty-log">작업을 시작하면 로그가 표시됩니다.</p>
                ) : (
                  logs.map(log => (
                    <div key={log.id} className="log-item">
                      <span className="log-time">[{log.time}]</span>
                      <span className="log-msg">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </Card>

            <Button 
                variant="primary" 
                icon={Play} 
                onClick={startProcessing}
                disabled={!file || isProcessing}
                className="start-btn-large"
              >
                {isProcessing ? '처리 중...' : '변환 시작'}
            </Button>
          </div>

          {/* Right Column: Status & Preview */}
          <div className="status-panel">
            <Card className="status-card">
              <div className="progress-section">
                 <ProgressBar 
                    progress={progress} 
                    label="전체 진행 상태" 
                    status={statusText}
                  />
              </div>
            </Card>

            <Card className="preview-card flex-grow">
              <div className="card-header">
                <h2>결과 미리보기</h2>
                {result && (
                  <div className="action-buttons-mini">
                    <Button variant="secondary" onClick={() => downloadFile('docx')}>Word</Button>
                    <Button variant="secondary" onClick={() => downloadFile('md')}>MD</Button>
                  </div>
                )}
              </div>
              
              <div className="preview-container">
                {result ? (
                  <div className="result-content">
                    <div className="summary-header-grid">
                      <div className="summary-box main-summary">
                        <h3><CheckCircle size={18} color="var(--success)"/> 핵심 요약</h3>
                        <p>{result.summary?.overview}</p>
                      </div>
                      <div className="pulse-stats-box">
                        <div className="stat-item">
                           <span className="stat-label">회의 성격</span>
                           <span className="stat-value text-accent">의사결정</span>
                        </div>
                        <div className="stat-item">
                           <span className="stat-label">참여자</span>
                           <span className="stat-value">{new Set(result.segments?.map(s => s.speaker_name)).size}명</span>
                        </div>
                      </div>
                    </div>
                    
                    <div className="grid-2-col">
                      <Card className="inner-card">
                        <h4>📌 주요 논의사항</h4>
                        <ul className="rich-list">
                          {result.summary?.topics?.map((t, i) => <li key={i}>{t}</li>)}
                        </ul>
                      </Card>
                      <Card className="inner-card">
                        <h4>✅ 결정사항</h4>
                        <ul className="rich-list decision">
                          {result.summary?.decisions?.map((d, i) => <li key={i}>{d}</li>)}
                        </ul>
                      </Card>
                    </div>

                    <div className="result-section">
                      <h4>🚀 다음 할 일 (Action Items)</h4>
                      <div className="action-grid">
                         {result.summary?.actions?.map((a, i) => (
                           <div key={i} className="action-card">
                             <div className="action-check"></div>
                             <div className="action-text">{a}</div>
                           </div>
                         ))}
                      </div>
                    </div>

                    <div className="transcript-area">
                      <div className="section-header">
                        <h4>💬 대화 기록</h4>
                        <span className="badge">전체 {result.segments?.length}문장</span>
                      </div>
                      <div className="transcript-scroll">
                        {result.segments?.map((s, i) => (
                          <div key={i} className="transcript-bubble">
                            <div className="bubble-info">
                              <span className="bubble-spk">{s.speaker_name || '화자'}</span>
                              <span className="bubble-time">{Math.floor(s.start / 60)}:{(s.start % 60).toString().padStart(2, '0')}</span>
                            </div>
                            <div className="bubble-text">{s.text}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="empty-preview">
                    {isProcessing ? (
                      <div className="loading-state">
                        <div className="spinner"></div>
                        <p>회의 내용을 분석하고 있습니다...</p>
                      </div>
                    ) : (
                      <p>파일을 변환하면 여기에 회의 요약 정보가 나타납니다.</p>
                    )}
                  </div>
                )}
              </div>
            </Card>
          </div>
          
        </div>
      </main>
    </div>
  );
}

export default App;
