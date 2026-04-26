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
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import './index.css';

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
        
        const resJson = await fetch(`${API_BASE}/result/${currentJobId}`);
        if(resJson.ok) {
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
      const response = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        body: formData,
      });
      
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
    if(!jobId) return;
    window.location.href = `${API_BASE}/download/${jobId}/${fmt}`;
  };

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  return (
    <div className={`min-h-screen transition-colors duration-500 relative overflow-hidden ${theme === 'dark' ? 'dark text-white' : 'text-slate-900 font-sans'}`}>
      {/* Dynamic Background Layer */}
      <div className="fixed inset-0 z-0 bg-[#f8fafc] dark:bg-[#09090b] transition-colors duration-500">
        <div 
          className="absolute inset-0 bg-cover bg-center opacity-40 dark:opacity-20 transition-opacity duration-700"
          style={{ backgroundImage: "url('./assets/bg.png')" }}
        />
        <div className="absolute inset-0 bg-white/40 dark:bg-black/60 backdrop-blur-[2px]" />
      </div>

      <div className="relative z-10 flex flex-col h-screen">
        {/* Premium Header */}
        <header className="flex items-center justify-between px-8 py-4 border-b border-black/5 dark:border-white/5 backdrop-blur-xl bg-white/20 dark:bg-black/40">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-primary/10 shadow-sm border border-primary/20">
              <FileAudio size={24} className="text-primary" />
            </div>
            <h1 className="text-xl font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-primary via-primary to-secondary">
              스마트 회의록 시스템
            </h1>
          </div>
          <div className="flex items-center gap-4">
            {isProcessing && (
              <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 animate-pulse">
                <div className="w-2 h-2 rounded-full bg-primary" />
                <span className="text-[10px] font-black text-primary uppercase tracking-wider">AI 분석 중</span>
              </div>
            )}
            <Button 
              variant="outline" 
              size="icon" 
              className="rounded-full bg-white/20 dark:bg-white/5 border-white/20 dark:border-white/10 hover:bg-white/40 dark:hover:bg-white/10"
              onClick={toggleTheme}
            >
              {theme === 'light' ? <Sun size={18} className="text-orange-500" /> : <Moon size={18} className="text-primary" />}
            </Button>
          </div>
        </header>

        {/* Main Application Area */}
        <main className="flex-1 p-6 overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-8 h-full max-w-[1700px] mx-auto">
            
            {/* Left: Input & Logs */}
            <div className="flex flex-col gap-6 overflow-y-auto">
              {/* Upload Card */}
              <Card className="glass-card border-none shadow-2xl rounded-[2.5rem] overflow-hidden">
                <CardHeader className="pb-4">
                  <div className="flex items-center gap-2">
                    <UploadCloud size={18} className="text-primary" />
                    <CardTitle className="text-lg font-bold">회의 파일 업로드</CardTitle>
                  </div>
                  <CardDescription>오디오 또는 동영상 파일을 분석합니다</CardDescription>
                </CardHeader>
                <CardContent>
                  <div 
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleFileDrop}
                    className={`group border-2 border-dashed rounded-3xl p-10 transition-all flex flex-col items-center justify-center gap-4 cursor-pointer
                      ${file ? 'border-primary bg-primary/5' : 'border-slate-200 dark:border-white/10 hover:border-primary/50 hover:bg-white/5'}`}
                    onClick={() => document.getElementById('fileInput').click()}
                  >
                    <input id="fileInput" type="file" className="hidden" onChange={handleFileSelect} accept="audio/*,video/*,.avi,.mkv,.mov" />
                    <div className={`p-5 rounded-full transition-all group-hover:scale-110 ${file ? 'bg-primary/20 text-primary shadow-lg shadow-primary/20' : 'bg-slate-50 dark:bg-white/5 text-slate-300'}`}>
                      <FileAudio size={40} />
                    </div>
                    <div className="text-center">
                      <p className="font-bold text-slate-700 dark:text-slate-200 max-w-[240px] truncate">
                        {file ? file.name : '파일을 선택하거나 끌어오세요'}
                      </p>
                      <p className="text-xs text-slate-400 mt-2 font-medium">MP3, WAV, MP4, AVI, MKV 지원</p>
                    </div>
                  </div>
                </CardContent>
                <CardFooter>
                  <Button 
                    disabled={!file || isProcessing}
                    onClick={startProcessing}
                    className="w-full h-14 rounded-2xl font-black text-sm uppercase tracking-[0.2em] transition-all"
                  >
                    {isProcessing ? (
                      <span className="flex items-center gap-2">
                         <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                         AI 분석 진행 중...
                      </span>
                    ) : '회의록 생성 시작'}
                  </Button>
                </CardFooter>
              </Card>

              {/* Real-time Logs */}
              <Card className="glass-card border-none shadow-2xl rounded-[2.5rem] flex-1 flex flex-col overflow-hidden min-h-[300px]">
                <CardHeader className="pb-2">
                   <div className="flex items-center justify-between">
                    <CardTitle className="text-xs font-black text-slate-400 dark:text-slate-500 uppercase tracking-[0.2em]">System Pipeline</CardTitle>
                    <div className="flex gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-red-400/30" />
                      <div className="w-2 h-2 rounded-full bg-yellow-400/30" />
                      <div className="w-2 h-2 rounded-full bg-green-400/30" />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 overflow-y-auto pr-4 custom-scrollbar font-mono text-[11px] space-y-4 pt-4">
                  {logs.map(log => (
                    <div key={log.id} className="flex gap-4 animate-in fade-in slide-in-from-left-4 duration-700">
                      <span className="text-primary/60 shrink-0 font-bold tabular-nums">[{log.time}]</span>
                      <span className="text-slate-500 dark:text-slate-400 leading-relaxed font-medium">{log.message}</span>
                    </div>
                  ))}
                  {logs.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-slate-300 dark:text-slate-700 italic gap-2 py-20">
                      <div className="w-8 h-px bg-slate-200 dark:bg-white/5" />
                      <span>대기 중인 로그가 없습니다</span>
                      <div className="w-8 h-px bg-slate-200 dark:bg-white/5" />
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Right: Analysis Dashboard */}
            <Card className="glass-card rounded-[3rem] flex flex-col overflow-hidden relative border-none shadow-2xl">
              {/* Main Content Scrollable Area */}
              <div className="flex-1 overflow-y-auto p-12 custom-scrollbar">
                {!result && !isProcessing && (
                  <div className="h-full flex flex-col items-center justify-center text-center max-w-lg mx-auto">
                    <div className="relative mb-10">
                      <div className="absolute inset-0 bg-primary/20 blur-[80px] rounded-full" />
                      <div className="relative w-28 h-28 rounded-[2.5rem] bg-gradient-to-br from-white to-slate-50 dark:from-white/5 dark:to-white/10 flex items-center justify-center shadow-inner border border-white/40 dark:border-white/5">
                        <FileText size={54} className="text-slate-300 dark:text-slate-600 translate-y-1" />
                      </div>
                    </div>
                    <h2 className="text-4xl font-black text-slate-800 dark:text-white leading-tight tracking-tight">AI 분석 대시보드</h2>
                    <p className="text-slate-400 dark:text-slate-500 mt-6 text-xl font-medium leading-relaxed">
                      회의 파일을 업로드하고 분석을 시작하세요.<br/>AI가 핵심 요약, 결정 사항, 주요 토픽을<br/>정밀하게 추출하여 드립니다.
                    </p>
                  </div>
                )}

                {isProcessing && (
                  <div className="h-full flex flex-col items-center justify-center text-center">
                    <div className="relative mb-16 scale-110">
                      <div className="absolute inset-0 bg-primary/30 blur-[120px] animate-pulse-slow rounded-full" />
                      <div className="relative w-52 h-52 flex items-center justify-center">
                         <div className="absolute inset-0 rounded-full border-[8px] border-slate-100 dark:border-white/5" />
                         <Progress value={progress} className="absolute inset-0 w-full h-full rounded-full bg-transparent overflow-visible" 
                           style={{ transform: 'rotate(-90deg)' }}
                         />
                         <svg className="absolute inset-0 w-full h-full -rotate-90">
                           <circle 
                             cx="104" cy="104" r="94" 
                             fill="none" stroke="currentColor" strokeWidth="12"
                             className="text-primary transition-all duration-1000 ease-in-out"
                             strokeDasharray={590}
                             strokeDashoffset={590 - (590 * progress / 100)}
                             strokeLinecap="round"
                           />
                         </svg>
                         <div className="flex flex-col items-center z-10">
                           <span className="text-5xl font-black text-primary tracking-tighter tabular-nums">{progress}%</span>
                           <span className="text-[11px] font-black text-slate-400 uppercase tracking-[0.3em] mt-2 ml-1">Processing</span>
                         </div>
                      </div>
                    </div>
                    <h3 className="text-3xl font-black text-slate-800 dark:text-white mb-4 animate-in fade-in slide-in-from-bottom-4">{statusText}</h3>
                    <p className="text-slate-400 dark:text-slate-500 font-bold max-w-sm mx-auto leading-relaxed">
                      대규모 언어 모델이 회의 문맥을 이해하고<br/>구조화된 보고서를 생성하고 있습니다.
                    </p>
                  </div>
                )}

                {result && (
                  <div className="space-y-16 animate-in fade-in zoom-in-95 duration-1000">
                    {/* Meta Header */}
                    <div className="flex flex-wrap items-center gap-4 pb-10 border-b border-black/5 dark:border-white/5">
                      <div className="flex items-center gap-2.5 px-6 py-3 rounded-2xl bg-primary/10 text-primary border border-primary/20">
                        <Clock size={20} className="stroke-[2.5]" />
                        <span className="text-base font-black uppercase tracking-tight">{result.duration || '00:00:00'}</span>
                      </div>
                      <div className="flex items-center gap-2.5 px-6 py-3 rounded-2xl bg-secondary/10 text-secondary border border-secondary/20">
                        <Users size={20} className="stroke-[2.5]" />
                        <span className="text-base font-black uppercase tracking-tight">{result.speaker_count || '0'}명 참여</span>
                      </div>
                      <div className="flex items-center gap-2.5 px-6 py-3 rounded-2xl bg-green-500/10 text-green-500 border border-green-500/20">
                        <CheckCircle2 size={20} className="stroke-[2.5]" />
                        <span className="text-base font-black uppercase tracking-tight">분석 완료</span>
                      </div>
                    </div>

                    {/* Executive Summary Card */}
                    <Card className="relative overflow-hidden p-10 rounded-[3rem] bg-gradient-to-br from-primary/15 to-secondary/15 border-none shadow-xl">
                      <div className="relative z-10">
                        <div className="flex items-center gap-4 mb-6">
                          <div className="p-3 rounded-2xl bg-white/50 dark:bg-black/40 shadow-sm border border-white/20">
                            <MessageSquare size={28} className="text-primary" />
                          </div>
                          <CardTitle className="text-2xl font-black text-slate-800 dark:text-white">AI 핵심 요약</CardTitle>
                        </div>
                        <p className="text-2xl text-slate-700 dark:text-slate-100 leading-relaxed font-bold italic tracking-tight">
                          "{result.summary || '요약된 내용이 없습니다.'}"
                        </p>
                      </div>
                      <div className="absolute top-0 right-0 w-80 h-80 bg-primary/20 blur-[120px] -mr-40 -mt-40 rounded-full" />
                      <div className="absolute bottom-0 left-0 w-64 h-64 bg-secondary/20 blur-[100px] -ml-32 -mb-32 rounded-full" />
                    </Card>

                    {/* Analysis Dashboard Grid */}
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-10">
                      <div className="space-y-8">
                        <div className="flex items-center justify-between px-4">
                          <h4 className="flex items-center gap-2 text-xs font-black text-primary uppercase tracking-[0.4em]">Main Topics</h4>
                          <span className="text-[10px] font-bold text-slate-300">{(result.topics?.length || 0)} ITEMS</span>
                        </div>
                        <div className="grid grid-cols-1 gap-4">
                          {(result.topics || ['인프라 개선', '디자인 시스템 적용', '일정 검토']).map((topic, i) => (
                            <div key={i} className="group flex items-center justify-between p-6 rounded-[2rem] bg-white/40 dark:bg-white/5 border border-black/5 dark:border-white/5 hover:bg-white dark:hover:bg-white/10 transition-all cursor-default shadow-sm hover:shadow-md">
                              <div className="flex items-center gap-5">
                                <span className="text-primary font-black opacity-20 text-2xl tracking-tighter">0{i+1}</span>
                                <span className="font-black text-lg text-slate-700 dark:text-slate-100">{topic}</span>
                              </div>
                              <ArrowRight size={20} className="text-slate-200 dark:text-slate-800 group-hover:text-primary group-hover:translate-x-1 transition-all" />
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-8">
                         <div className="flex items-center justify-between px-4">
                          <h4 className="flex items-center gap-2 text-xs font-black text-secondary uppercase tracking-[0.4em]">Decisions</h4>
                          <span className="text-[10px] font-bold text-slate-300">{(result.actions?.length || 0)} ITEMS</span>
                        </div>
                        <div className="grid grid-cols-1 gap-4">
                          {(result.actions || ['차주 금요일까지 초기 프로토타입 완료', '디자인 가이드라인 확정']).map((action, i) => (
                            <div key={i} className="flex items-start gap-5 p-6 rounded-[2rem] bg-white/40 dark:bg-white/5 border border-black/5 dark:border-white/5 shadow-sm">
                              <div className="mt-1.5 w-6 h-6 rounded-xl bg-secondary/20 flex items-center justify-center shrink-0 border border-secondary/20">
                                <CheckCircle2 size={14} className="text-secondary" />
                              </div>
                              <span className="font-bold text-lg text-slate-700 dark:text-slate-100 leading-snug">{action}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Full Transcription Preview */}
                    <section className="space-y-8 pb-12">
                      <h4 className="flex items-center gap-2 text-xs font-black text-slate-400 uppercase tracking-[0.4em] pl-4">Raw Transcription</h4>
                      <div className="relative group">
                        <div className="p-10 rounded-[3rem] bg-slate-100/50 dark:bg-black/40 border border-black/5 dark:border-white/5 max-h-[600px] overflow-y-auto leading-[2.2] text-slate-500 dark:text-slate-400 font-bold text-lg custom-scrollbar italic tracking-tight">
                          {result.text || '대화 내용이 아직 추출되지 않았습니다.'}
                        </div>
                        <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-[#f8fafc] dark:from-[#09090b] to-transparent pointer-events-none rounded-b-[3rem] transition-opacity duration-500 opacity-100 group-hover:opacity-0" />
                      </div>
                    </section>
                  </div>
                )}
              </div>

              {/* Action Footer Bar */}
              {result && (
                <div className="p-10 border-t border-black/5 dark:border-white/5 backdrop-blur-3xl bg-white/60 dark:bg-black/60 flex flex-wrap items-center justify-between gap-8">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center border border-green-500/20">
                      <CheckCircle size={20} className="text-green-500" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</span>
                      <span className="text-xs font-bold text-slate-600 dark:text-slate-300 italic">Report generated by Smart Minutes AI</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-5">
                    <Button 
                      variant="outline"
                      onClick={() => downloadFile('txt')}
                      className="h-14 px-8 rounded-2xl bg-white/60 dark:bg-white/5 border-black/5 dark:border-white/5 hover:bg-white dark:hover:bg-white/10 font-black text-xs uppercase tracking-widest transition-all shadow-sm"
                    >
                      <Download size={20} />
                      <span>텍스트 파일</span>
                    </Button>
                    <Button 
                      onClick={() => downloadFile('docx')}
                      className="h-14 px-10 rounded-2xl bg-primary text-white font-black text-xs uppercase tracking-[0.2em] transition-all hover:scale-105 shadow-2xl shadow-primary/30"
                    >
                      <FileText size={20} />
                      <span>워드 문서 내보내기</span>
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          </div>
        </main>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 10px; }
        .dark .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); }
      `}} />
    </div>
  );
}

export default App;
