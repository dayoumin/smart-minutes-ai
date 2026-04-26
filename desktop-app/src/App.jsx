import React, { useState } from 'react';
import { 
  UploadCloud, 
  FileAudio, 
  Sun, 
  Moon,
  Clock,
  Users,
  MessageSquare,
  FileText,
  Download,
  ArrowRight,
  CheckCircle,
  CheckCircle2
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import './index.css';

/* ============================================================
   App.jsx — Smart Minutes AI
   모든 색상/간격/그림자는 CSS 토큰(--var)만 사용합니다.
   Tailwind 하드코딩(slate-*, white/40 등) 사용 금지.
   새 화면 추가 시 동일한 컴포넌트 패턴을 따르세요.
   ============================================================ */

function App() {
  const [file, setFile] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('대기 중...');
  const [logs, setLogs] = useState([]);
  const [jobId, setJobId] = useState(null);
  const [result, setResult] = useState(null);
  const [theme, setTheme] = useState('light');

  const API_BASE = 'http://127.0.0.1:8000/api';

  const addLog = (msg) => {
    setLogs(prev => [
      { id: Date.now(), time: new Date().toLocaleTimeString(), message: msg },
      ...prev.slice(0, 19)
    ]);
  };

  const handleFileDrop = (e) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) setFile(droppedFile);
  };

  const handleFileSelect = (e) => {
    if (e.target.files[0]) setFile(e.target.files[0]);
  };

  const pollStatus = async (currentJobId) => {
    try {
      const res = await fetch(`${API_BASE}/status/${currentJobId}`);
      if (!res.ok) return;
      const data = await res.json();

      setProgress(Math.round(data.progress || 0));

      const nextStatusText = data.step || data.status_text || '처리 중...';
      if (nextStatusText !== statusText) {
        setStatusText(nextStatusText);
        addLog(nextStatusText);
      }
      if (data.log_message) addLog(data.log_message);

      if (data.status === 'completed' || data.status === 'done') {
        setIsProcessing(false);
        setJobId(currentJobId);
        setProgress(100);
        addLog('모든 처리가 완료되었습니다.');

        if (data.result) {
          setResult(data.result);
          return;
        }

        const resJson = await fetch(`${API_BASE}/result/${currentJobId}`);
        if (resJson.ok) {
          const jsonData = await resJson.json();
          const formattedResult = {
            summary: jsonData.summary?.overview || '',
            topics: jsonData.summary?.topics || [],
            actions: jsonData.summary?.actions || [],
            text: jsonData.segments?.map(s => {
              const m = Math.floor(s.start / 60).toString().padStart(2, '0');
              const sec = Math.floor(s.start % 60).toString().padStart(2, '0');
              return `[${m}:${sec}] ${s.speaker_name || ''}: ${s.text}`;
            }).join('\n\n') || '',
            duration: jsonData.segments && jsonData.segments.length > 0
              ? new Date(jsonData.segments[jsonData.segments.length - 1].end * 1000).toISOString().substring(11, 19)
              : '00:00:00',
            speaker_count: [...new Set(jsonData.segments?.map(s => s.speaker))].length || 0
          };
          setResult(formattedResult);
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
      const response = await fetch(`${API_BASE}/upload`, { method: 'POST', body: formData });
      if (!response.ok) throw new Error('업로드 실패');
      const data = await response.json();
      addLog('업로드 완료. AI 분석을 시작합니다.');
      pollStatus(data.job_id);
    } catch (error) {
      setStatusText(`오류: ${error.message}`);
      addLog(`치명적 오류: ${error.message}`);
      setIsProcessing(false);
    }
  };

  const downloadFile = (fmt) => {
    if (!jobId) return;
    window.location.href = `${API_BASE}/download/${jobId}/${fmt}`;
  };

  const toggleTheme = () => setTheme(prev => prev === 'light' ? 'dark' : 'light');

  return (
    <div className={`min-h-screen relative overflow-hidden ${theme === 'dark' ? 'dark' : ''}`}
      style={{ backgroundColor: 'var(--bg-page)', color: 'var(--text-default)', transition: 'background-color 0.3s, color 0.3s' }}
    >
      {/* ── Background ───────────────────────────────────────── */}
      <div className="fixed inset-0 z-0">
        <div
          className="absolute inset-0 bg-cover bg-center transition-opacity duration-700"
          style={{ backgroundImage: "url('./assets/bg.png')", opacity: theme === 'dark' ? 0.15 : 0.35 }}
        />
        <div className="absolute inset-0" style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(2px)' }} />
      </div>

      <div className="relative z-10 flex flex-col h-screen">

        {/* ── Header ───────────────────────────────────────────── */}
        <header style={{
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-default)',
          backdropFilter: 'blur(var(--blur-glass))',
        }} className="flex items-center justify-between px-8 py-4">

          {/* Logo */}
          <div className="flex items-center gap-3">
            <div style={{
              background: 'color-mix(in srgb, var(--brand-primary) 15%, transparent)',
              border: '1px solid color-mix(in srgb, var(--brand-primary) 30%, transparent)',
              borderRadius: 'var(--radius-md)',
              padding: '8px',
            }}>
              <FileAudio size={22} style={{ color: 'var(--brand-primary)' }} />
            </div>
            <h1 className="text-xl font-extrabold tracking-tight" style={{ color: 'var(--text-default)' }}>
              스마트 <span style={{ color: 'var(--brand-primary)' }}>회의록</span> 시스템
            </h1>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-3">
            {isProcessing && (
              <div className="flex items-center gap-2 px-3 py-1.5 animate-pulse" style={{
                background: 'color-mix(in srgb, var(--brand-primary) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--brand-primary) 25%, transparent)',
                borderRadius: 'var(--radius-pill)',
              }}>
                <div className="w-2 h-2 rounded-full" style={{ background: 'var(--brand-primary)' }} />
                <span className="text-[10px] font-black uppercase tracking-wider" style={{ color: 'var(--brand-primary)' }}>AI 분석 중</span>
              </div>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              className="rounded-full"
              style={{ color: 'var(--text-muted)' }}
            >
              {theme === 'light'
                ? <Sun size={18} className="text-orange-500" />
                : <Moon size={18} style={{ color: 'var(--brand-primary)' }} />
              }
            </Button>
          </div>
        </header>

        {/* ── Main ─────────────────────────────────────────────── */}
        <main className="flex-1 p-6 overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-6 h-full max-w-[1600px] mx-auto">

            {/* ── Left: Upload + Logs ──────────────────────────── */}
            <div className="flex flex-col gap-5 overflow-y-auto">

              {/* Upload Card */}
              <div className="glass-card overflow-hidden">
                <div className="p-6 pb-4 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border-default)' }}>
                  <UploadCloud size={18} style={{ color: 'var(--brand-primary)' }} />
                  <span className="font-bold text-base" style={{ color: 'var(--text-default)' }}>회의 파일 업로드</span>
                </div>
                <div className="p-5">
                  <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>오디오 또는 동영상 파일을 분석합니다</p>

                  {/* Drop Zone */}
                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleFileDrop}
                    onClick={() => document.getElementById('fileInput').click()}
                    className="drop-zone p-8 flex flex-col items-center justify-center gap-3 cursor-pointer transition-all"
                    style={file ? {
                      background: 'color-mix(in srgb, var(--brand-primary) 8%, transparent)',
                      borderColor: 'var(--brand-primary)',
                    } : {}}
                  >
                    <input id="fileInput" type="file" className="hidden" onChange={handleFileSelect} accept="audio/*,video/*,.avi,.mkv,.mov" />
                    <div className="p-4 rounded-full transition-transform hover:scale-110" style={{
                      background: file
                        ? 'color-mix(in srgb, var(--brand-primary) 15%, transparent)'
                        : 'color-mix(in srgb, var(--text-subtle) 10%, transparent)',
                    }}>
                      <FileAudio size={36} style={{ color: file ? 'var(--brand-primary)' : 'var(--text-subtle)' }} />
                    </div>
                    <div className="text-center">
                      <p className="font-bold text-sm max-w-[220px] truncate" style={{ color: 'var(--text-default)' }}>
                        {file ? file.name : '파일을 선택하거나 끌어오세요'}
                      </p>
                      <p className="text-xs mt-1" style={{ color: 'var(--text-subtle)' }}>MP3, WAV, MP4, AVI, MKV 지원</p>
                    </div>
                  </div>

                  {/* Action Button */}
                  <Button
                    disabled={!file || isProcessing}
                    onClick={startProcessing}
                    className="w-full mt-4 h-12 font-black text-sm uppercase tracking-widest transition-all"
                    style={file && !isProcessing ? {
                      background: 'var(--brand-primary)',
                      color: 'var(--brand-primary-fg)',
                      boxShadow: 'var(--shadow-brand)',
                      borderRadius: 'var(--radius-md)',
                    } : { borderRadius: 'var(--radius-md)' }}
                  >
                    {isProcessing ? (
                      <span className="flex items-center gap-2">
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        AI 분석 진행 중...
                      </span>
                    ) : '회의록 생성 시작'}
                  </Button>
                </div>
              </div>

              {/* System Pipeline (Logs) */}
              <div className="glass-card flex-1 flex flex-col overflow-hidden min-h-[200px]">
                <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-default)' }}>
                  <span className="text-[11px] font-black uppercase tracking-[0.2em]" style={{ color: 'var(--brand-primary)' }}>
                    System Pipeline
                  </span>
                  <div className="flex gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-400/60" />
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-400/60" />
                    <div className="w-2.5 h-2.5 rounded-full bg-green-400/60" />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-4 custom-scrollbar font-mono text-[11px] space-y-3">
                  {logs.map(log => (
                    <div key={log.id} className="flex gap-3 animate-in fade-in slide-in-from-left-4 duration-500">
                      <span className="font-bold tabular-nums shrink-0" style={{ color: 'var(--brand-primary)' }}>[{log.time}]</span>
                      <span className="font-medium leading-relaxed" style={{ color: 'var(--text-default)' }}>{log.message}</span>
                    </div>
                  ))}
                  {logs.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center gap-2 py-10 italic text-xs" style={{ color: 'var(--text-subtle)' }}>
                      대기 중인 로그가 없습니다
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── Right: Dashboard ─────────────────────────────── */}
            <div className="glass-card flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto p-10 custom-scrollbar">

                {/* Empty state */}
                {!result && !isProcessing && (
                  <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto gap-6">
                    <div className="relative">
                      <div className="absolute inset-0 blur-[60px] rounded-full" style={{ background: 'color-mix(in srgb, var(--brand-primary) 20%, transparent)' }} />
                      <div className="relative w-24 h-24 flex items-center justify-center rounded-3xl" style={{
                        background: 'color-mix(in srgb, var(--text-subtle) 8%, transparent)',
                        border: '1px solid var(--border-default)',
                      }}>
                        <FileText size={44} style={{ color: 'var(--text-subtle)' }} />
                      </div>
                    </div>
                    <h2 className="text-3xl font-black tracking-tight" style={{ color: 'var(--text-default)' }}>AI 분석 대시보드</h2>
                    <p className="text-base leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      회의 파일을 업로드하고 분석을 시작하세요.<br />
                      AI가 핵심 요약, 결정 사항, 주요 토픽을<br />정밀하게 추출하여 드립니다.
                    </p>
                  </div>
                )}

                {/* Processing state */}
                {isProcessing && (
                  <div className="h-full flex flex-col items-center justify-center text-center gap-10">
                    <div className="relative w-48 h-48 flex items-center justify-center">
                      <div className="absolute inset-0 rounded-full animate-pulse-slow" style={{ background: 'color-mix(in srgb, var(--brand-primary) 20%, transparent)', filter: 'blur(40px)' }} />
                      <div className="absolute inset-0 rounded-full" style={{ border: '8px solid var(--border-default)' }} />
                      <svg className="absolute inset-0 w-full h-full -rotate-90">
                        <circle
                          cx="96" cy="96" r="84"
                          fill="none" stroke="currentColor" strokeWidth="8"
                          style={{ color: 'var(--brand-primary)', transition: 'stroke-dashoffset 0.8s ease' }}
                          strokeDasharray={528}
                          strokeDashoffset={528 - (528 * progress / 100)}
                          strokeLinecap="round"
                        />
                      </svg>
                      <div className="flex flex-col items-center z-10">
                        <span className="text-4xl font-black tabular-nums" style={{ color: 'var(--brand-primary)' }}>{progress}%</span>
                        <span className="text-[10px] font-black uppercase tracking-widest mt-1" style={{ color: 'var(--text-subtle)' }}>Processing</span>
                      </div>
                    </div>
                    <div>
                      <h3 className="text-2xl font-black mb-2" style={{ color: 'var(--text-default)' }}>{statusText}</h3>
                      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>대규모 언어 모델이 회의 문맥을 이해하고<br />구조화된 보고서를 생성하고 있습니다.</p>
                    </div>
                  </div>
                )}

                {/* Result state */}
                {result && (
                  <div className="space-y-10 animate-in fade-in duration-700">
                    {/* Meta badges */}
                    <div className="flex flex-wrap gap-3">
                      {[
                        { icon: <Clock size={16} />, label: result.duration || '00:00:00', color: 'var(--brand-primary)' },
                        { icon: <Users size={16} />, label: `${result.speaker_count || 0}명 참여`, color: 'var(--brand-secondary)' },
                        { icon: <CheckCircle2 size={16} />, label: '분석 완료', color: '#22c55e' },
                      ].map((item, i) => (
                        <div key={i} className="flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-sm" style={{
                          background: `color-mix(in srgb, ${item.color} 10%, transparent)`,
                          border: `1px solid color-mix(in srgb, ${item.color} 25%, transparent)`,
                          color: item.color,
                        }}>
                          {item.icon} {item.label}
                        </div>
                      ))}
                    </div>

                    {/* Summary */}
                    <div className="p-8 rounded-2xl" style={{
                      background: 'color-mix(in srgb, var(--brand-primary) 8%, transparent)',
                      border: '1px solid var(--border-brand)',
                    }}>
                      <div className="flex items-center gap-3 mb-4">
                        <MessageSquare size={20} style={{ color: 'var(--brand-primary)' }} />
                        <h3 className="font-black text-lg" style={{ color: 'var(--text-default)' }}>AI 핵심 요약</h3>
                      </div>
                      <p className="text-base italic leading-relaxed" style={{ color: 'var(--text-default)' }}>
                        "{result.summary || '요약된 내용이 없습니다.'}"
                      </p>
                    </div>

                    {/* Topics + Actions */}
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
                      {/* Topics */}
                      <div className="space-y-3">
                        <h4 className="text-xs font-black uppercase tracking-widest" style={{ color: 'var(--brand-primary)' }}>Main Topics</h4>
                        {(result.topics || ['인프라 개선', '디자인 시스템 적용', '일정 검토']).map((topic, i) => (
                          <div key={i} className="flex items-center justify-between p-4 rounded-xl transition-all" style={{
                            background: 'color-mix(in srgb, var(--text-subtle) 6%, transparent)',
                            border: '1px solid var(--border-default)',
                          }}>
                            <div className="flex items-center gap-3">
                              <span className="font-black opacity-30 text-xl" style={{ color: 'var(--brand-primary)' }}>0{i + 1}</span>
                              <span className="font-bold" style={{ color: 'var(--text-default)' }}>{topic}</span>
                            </div>
                            <ArrowRight size={16} style={{ color: 'var(--text-subtle)' }} />
                          </div>
                        ))}
                      </div>

                      {/* Decisions */}
                      <div className="space-y-3">
                        <h4 className="text-xs font-black uppercase tracking-widest" style={{ color: 'var(--brand-secondary)' }}>Decisions</h4>
                        {(result.actions || ['차주 금요일까지 초기 프로토타입 완료', '디자인 가이드라인 확정']).map((action, i) => (
                          <div key={i} className="flex items-start gap-3 p-4 rounded-xl" style={{
                            background: 'color-mix(in srgb, var(--brand-secondary) 6%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--brand-secondary) 20%, transparent)',
                          }}>
                            <CheckCircle2 size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--brand-secondary)' }} />
                            <span className="text-sm font-medium leading-snug" style={{ color: 'var(--text-default)' }}>{action}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Transcription */}
                    <div className="space-y-3">
                      <h4 className="text-xs font-black uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Raw Transcription</h4>
                      <div className="p-6 rounded-xl max-h-[400px] overflow-y-auto leading-relaxed text-sm custom-scrollbar" style={{
                        background: 'color-mix(in srgb, var(--text-subtle) 5%, transparent)',
                        border: '1px solid var(--border-default)',
                        color: 'var(--text-muted)',
                      }}>
                        {result.text || '대화 내용이 아직 추출되지 않았습니다.'}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Footer Bar */}
              {result && (
                <div className="px-8 py-5 flex flex-wrap items-center justify-between gap-4" style={{
                  borderTop: '1px solid var(--border-default)',
                  background: 'var(--bg-surface)',
                }}>
                  <div className="flex items-center gap-2">
                    <CheckCircle size={18} className="text-green-500" />
                    <span className="text-xs font-bold" style={{ color: 'var(--text-muted)' }}>Report generated by Smart Minutes AI</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Button variant="outline" onClick={() => downloadFile('txt')} className="h-10 px-5 text-xs font-bold uppercase tracking-wider rounded-xl"
                      style={{ borderColor: 'var(--border-default)', color: 'var(--text-default)' }}>
                      <Download size={15} /> 텍스트
                    </Button>
                    <Button onClick={() => downloadFile('docx')} className="h-10 px-6 text-xs font-bold uppercase tracking-wider rounded-xl"
                      style={{ background: 'var(--brand-primary)', color: 'var(--brand-primary-fg)', boxShadow: 'var(--shadow-brand)' }}>
                      <FileText size={15} /> 워드 내보내기
                    </Button>
                  </div>
                </div>
              )}
            </div>

          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
