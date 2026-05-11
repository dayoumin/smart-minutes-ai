# 오디오 성능 개선 작업 로그

이 문서는 회의록 앱의 음성 인식 품질과 처리 안정성을 개선할 때 반복해서 참고하기 위한 작업 로그다.  
목표는 "효과가 있어 보이는 필터를 바로 기본값으로 넣는 것"이 아니라, 샘플과 지표를 남기면서 다음 작업의 시행착오를 줄이는 것이다.

## 1. 기본 원칙

- 한 샘플에서 좋아 보여도 기본값으로 바꾸지 않는다.
- 전처리 기본값은 보수적으로 유지하고, 실험 기능은 설정에서 선택할 수 있게 둔다.
- denoise, silence trim처럼 말끝이나 자음을 없앨 수 있는 기능은 마지막에 검토한다.
- STT 정확도만 보지 말고 화자 분리, 요약, 처리 시간, 실패율까지 같이 본다.
- "소리가 더 커졌다"와 "회의록 품질이 좋아졌다"는 별개로 기록한다.

## 2. 권장 작업 순서

1. 샘플 선정
   - 깨끗한 음성
   - 작은 목소리
   - 잡음 많은 녹음
   - 다화자 회의
   - 긴 영상/음성

2. 객관 지표 확인
   - 원본 평균 음량
   - 전처리 후 평균 음량
   - 전처리 소요 시간
   - 파일 크기와 임시 파일 위치

3. STT 비교
   - 같은 구간을 `off / auto / loudnorm / speechnorm`으로 비교
   - 글자 수, 누락, 반복, 고유명사, 숫자, 발화 순서를 확인

4. 후속 품질 확인
   - 화자 분리 세그먼트가 더 나빠지지 않았는지 확인
   - 요약과 할 일 추출이 흔들리지 않았는지 확인

5. 기본값 판단
   - 전체 샘플에서 최소 동등하거나 개선될 때만 기본값 후보로 올린다.
   - 특정 상황에서만 좋은 기능은 설정 옵션으로 유지한다.

## 3. 2026-05-05 작업 교훈

### speechnorm 추가

- `speechnorm`을 작은 목소리 보정 후보로 추가했다.
- 기본값으로 켠 것이 아니라, 설정에서 고를 수 있는 실험/비교 모드로 추가했다.
- 이유: 작은 목소리에는 도움이 될 수 있지만 잡음도 같이 커질 수 있다.

### 60초 샘플 비교 결과

대상:

- `D:\Projects\audio` 루트의 가장 작은 MP4에서 60초 WAV를 추출했다.

결과:

| 모드 | 실제 처리 | 평균 음량 | STT 결과 |
| --- | --- | --- | --- |
| 원본 | 없음 | -19.5 dB | 기준 |
| 자동 | loudnorm | -16.2 dB | 2개 세그먼트, 492자 |
| 표준 보정 | loudnorm | -16.2 dB | 2개 세그먼트, 492자 |
| 작은 목소리 보정 | speechnorm | -14.3 dB | 2개 세그먼트, 490자 |

판단:

- 이번 샘플에서는 자동과 표준 보정이 같은 결과였다.
- `speechnorm`은 음량을 더 키웠지만 STT 개선은 뚜렷하지 않았다.
- `speechnorm`은 기본값으로 올리지 않는다.
- 다음 비교는 작은 목소리/잡음 샘플에서 한다.

### 발견한 시행착오

- 한글 파일 경로가 들어간 ffmpeg 로그를 Windows 기본 인코딩으로 읽으면 평균 음량 측정이 실패할 수 있었다.
- 이 문제 때문에 `mean_volume_db`가 `null`로 기록되어 비교가 흔들렸다.
- 해결: ffmpeg 로그 수집 시 `encoding="utf-8", errors="replace"`로 읽도록 수정했다.

## 4. 다음 작업 체크리스트

- [x] `Smart Minutes AI\video` 폴더의 영상 4개 앞 60초로 `auto / loudnorm / speechnorm` 1차 비교
- [ ] 작은 목소리 샘플 2개 이상으로 `auto / loudnorm / speechnorm` 추가 비교
- [ ] 잡음 많은 샘플 2개 이상으로 `auto / loudnorm / speechnorm` 추가 비교
- [ ] 회의형 다화자 샘플에서 화자 분리 영향 확인
- [ ] 30분 이상 샘플에서 처리 시간과 임시 파일 용량 확인
- [ ] 결과가 쌓이면 기본값 유지 또는 조정 판단
- [ ] 그 다음에만 silence trim 후보 검토
- [ ] denoise는 별도 브랜치나 별도 실험으로 마지막에 검토

## 5. 2026-05-05 video 폴더 60초 비교

대상:

- `D:\Projects\audio\Smart Minutes AI\video` 폴더의 MP4 4개
- 각 영상 앞 60초만 추출해 비교했다.
- 산출물: `backend\temp\preprocessing_eval_video\video_folder_preprocessing_eval_60s.json`

요약:

| 샘플 | 원본 평균 음량 | auto 결과 | loudnorm 결과 | speechnorm 결과 | 판단 |
| --- | ---: | --- | --- | --- | --- |
| Hermes Agent | -19.5 dB | loudnorm, -16.2 dB, 492자 | -16.2 dB, 492자 | -14.3 dB, 490자 | speechnorm 이점 없음 |
| 대선 TV 토론 | -27.8 dB | loudnorm, -17.5 dB, 478자 | -17.5 dB, 478자 | -21.8 dB, 448자 | speechnorm 불리 |
| DeepSeek 논문 읽기 | -17.0 dB | off, -17.0 dB, 594자 | -16.7 dB, 603자 | -14.4 dB, 621자 | 추가 청취 확인 필요 |
| AI 복지 돌봄 포럼 | -39.7 dB | loudnorm, -19.7 dB, 268자 | -19.7 dB, 268자 | -33.7 dB, 181자 | speechnorm 불리 |

판단:

- 현재 샘플 기준으로 `auto`는 작은 음량에서는 `loudnorm`, 충분한 음량에서는 `off`로 동작해 보수적인 결과를 냈다.
- `speechnorm`은 일부 샘플에서 음량을 키웠지만, 매우 작은 음량 샘플에서는 전사량이 줄거나 표기가 흔들렸다.
- `speechnorm`은 기본값 후보가 아니다. 비교용 옵션으로 유지한다.
- 다음 단계는 사람이 들어서 작은 목소리/잡음 샘플을 더 골라 비교하는 것이다.

## 6. 2026-05-05 자동화 평가 스크립트와 추가 실험

추가한 스크립트:

- `scripts/run_audio_performance_eval.py`
- `docs/audio-testset-manifest.csv`

목적:

- 같은 샘플에서 `normal / quiet / noise / silence_trim / denoise` 변형을 만든다.
- `off / auto / loudnorm / speechnorm` 전처리를 같은 방식으로 비교한다.
- 선택적으로 STT와 diarization을 실행해 결과를 JSON으로 남긴다.
- 긴 파일은 일정 길이만 WAV로 추출한 뒤 청크 개수와 임시 파일 용량을 기록한다.
- 기본 입력은 `Smart Minutes AI\video`지만, MP4뿐 아니라 WAV/MP3/M4A/FLAC 등 음성 파일도 같은 폴더에서 찾는다.
- STT 모델은 portable 배포 구조인 `Smart Minutes AI\models`를 먼저 찾고, 없으면 개발용 `backend\models\stt\cohere-transcribe-03-2026`를 찾는다.

실행한 명령:

```powershell
python scripts\run_audio_performance_eval.py --video-dir "Smart Minutes AI\video" --limit 2 --sample-seconds 60 --run-stt --long-seconds 1800 --output backend\temp\audio_performance_eval\stt_eval_limit2.json
python scripts\run_audio_performance_eval.py --video-dir "Smart Minutes AI\video" --limit 1 --sample-seconds 60 --run-diarization --long-seconds 1800 --output backend\temp\audio_performance_eval\diarization_eval_limit1.json
python scripts\run_audio_performance_eval.py --manifest docs\audio-testset-manifest.csv --limit 2 --sample-seconds 60 --run-stt --long-seconds 1800 --clean --output backend\temp\audio_performance_eval\manifest_stt_eval.json
```

운영 주의:

- 반복 실행 전 기존 평가 산출물을 지우려면 `--clean`을 붙인다.
- `--limit`은 STT/diarization을 돌릴 샘플 개수만 제한한다. 긴 파일 측정은 폴더 전체에서 가장 큰 파일을 고른다.
- 공식 테스트셋은 `docs/audio-testset-manifest.csv`를 우선 사용한다. 파일을 새로 넣거나 기준 샘플을 바꿀 때는 이 CSV만 갱신하면 같은 조건으로 재실행할 수 있다.
- 스크립트 JSON만 보고 기본값을 바꾸지 않는다. 사람이 청취한 품질 메모와 요약 품질 확인이 같이 필요하다.

### 작은 목소리/잡음 변형

요약:

- `quiet` 변형은 원본을 -15 dB 낮춘 실험 샘플이다.
- `noise` 변형은 낮은 백색 잡음을 섞은 실험 샘플이다.
- `quiet`에서 `speechnorm`은 글자 수를 크게 늘린 경우가 있었지만, 품질 개선인지 환각/반복 증가인지는 청취 확인이 필요하다.
- `noise`에서 `auto/loudnorm`은 안정적이었고, `speechnorm`은 명확한 우위를 보이지 않았다.

판단:

- 작은 목소리와 잡음에서도 `speechnorm`을 기본값으로 올릴 근거는 아직 없다.
- 다음에는 실제 작은 목소리/잡음 원본 샘플을 사람이 골라 비교해야 한다.

### 긴 파일 전처리/청크 측정

30분 샘플 결과:

| 샘플 | 요청 길이 | 실제 길이 | WAV 크기 | 청크 | 추출 시간 | 청크 생성 시간 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 대선 TV 토론 | 1800초 | 1800초 | 약 57.6 MB | 60개 | 0.857초 | 2.772초 |
| Hermes Agent | 1800초 | 1611초 | 약 51.6 MB | 54개 | 1.045초 | 2.318초 |

판단:

- WAV 추출과 30초 청크 생성은 병목이 아니다.
- 장시간 처리 병목은 STT, diarization, summary 쪽으로 봐야 한다.
- 따라서 긴 파일 개선은 "청크 생성 최적화"보다 "청크별 실패 복구, partial result 저장, 진행 상태 노출"이 우선이다.

### 화자 분리 영향

Hermes Agent 60초 샘플:

| 모드 | 화자 수 | diarization 세그먼트 | 처리 시간 |
| --- | ---: | ---: | ---: |
| auto | 3 | 11 | 8.03초 |
| loudnorm | 3 | 11 | 0.91초 |
| speechnorm | 3 | 11 | 0.85초 |

판단:

- 이 샘플에서는 전처리 모드가 화자 수/세그먼트 수를 바꾸지 않았다.
- 첫 실행은 모델 로딩 때문에 느리고, 이후 실행은 1초 안팎이었다.
- 화자분리 영향은 다화자 회의 샘플에서 추가 확인이 필요하다.

### silence trim / denoise 후보

초기 신호:

- `silence_trim`은 60초 샘플을 약 55~59초로 줄였다.
- `denoise`와 `silence_trim` 모두 STT 글자 수가 늘어난 경우가 있었다.

판단:

- 글자 수 증가는 품질 개선이 아니라 반복/환각 증가일 수 있다.
- 두 기능 모두 기본값 후보가 아니다.
- 특히 denoise는 한국어 자음과 말끝 손실 위험이 있어 별도 청취 검증 전에는 도입하지 않는다.

### Cohere 초반 환각 / noise gate 실험

대선 TV 토론 0~60초 샘플에서 Cohere가 초반 한국어를 `Taskejong`, `standing toron`처럼 로마자/영어식으로 오인식했다.

확인한 방법:

- 원본 0~60초를 Cohere에 직접 입력: 초반 30초 대부분이 로마자식 오인식.
- 3초 무음을 앞에 붙인 뒤 입력: 개선 없음.
- 같은 프로세스에서 3초 무음 더미를 먼저 인식한 뒤 실제 샘플 입력: 개선 없음.
- `punctuation=false` 재시도: 일부 한글 비율은 올라갔지만 단독 해결책으로는 부족.
- `agate=threshold=0.02:ratio=4:attack=5:release=100,loudnorm=I=-16:LRA=11:TP=-1.5` 적용 후 입력: 초반 소개 문장이 대부분 정상 한국어로 개선.

판단:

- 문제는 모델 워밍업이 아니라 초반 저음량/배경음/방송 오프닝 구간에서 발생하는 ASR 환각에 가깝다.
- Cohere 공식 모델 카드도 무음/저음량 잡음에 대해 VAD 또는 noise gate를 권장한다.
- 강한 denoise나 silence trim은 말끝 손실 위험이 있으므로 여전히 기본값 후보가 아니다.
- 약한 noise gate는 이 샘플에서 효과가 있어 기본 전처리에 포함하되, 작은 목소리 회의 샘플에서 추가 비교가 필요하다.

## 7. 2026-05-07 STT 품질 회귀 대응 계획

사용자 피드백:

- 이전보다 추출된 텍스트 품질이 상당히 떨어졌다.
- 단순 요약 품질 문제가 아니라, 음성 인식 원문 자체의 품질 저하로 보인다.

현재 가장 유력한 원인 후보:

1. `noise_gate=true`
   - 방송 샘플 1개에서는 초반 로마자식 오인식 개선 효과가 있었다.
   - 하지만 작은 목소리, 회의실 발언, 말끝이 약한 한국어에는 자음/받침/어미 손실을 만들 수 있다.
   - 따라서 기본값으로 유지하기 전에 실제 회의 샘플 검증이 필요하다.
2. 30초 단위 긴 파일 청크
   - 메모리와 진행률에는 유리하지만, 앞뒤 맥락이 끊겨 문장 시작/끝 품질이 흔들릴 수 있다.
   - 긴 파일에서는 30초, 60초, 90초를 비교한다.
3. Cohere long-form 결과의 timestamp 한계
   - 현재 Cohere는 정확한 word timestamp가 아니라 텍스트를 시간에 맞춰 나누는 방식이다.
   - 화자 분리 결과와 합치는 과정에서 문장 경계가 흔들리면 발화 기록 품질이 더 나빠 보일 수 있다.
4. 샘플 기준 부재
   - 기존 4개 영상 원본 폴더가 배포 정리 과정에서 제거되어, 같은 입력으로 전후 비교하기 어려워졌다.
   - 남아 있는 60초 WAV 파생 샘플과 새 기준 샘플을 사용해 회귀 테스트셋을 다시 고정해야 한다.

점검 순서:

1. 기준 샘플 고정
   - 깨끗한 음성, 작은 목소리, 잡음 많은 회의, 다화자 회의, 긴 영상/음성을 최소 5개로 구성한다.
   - 가능하면 사용자가 품질 저하를 느낀 실제 파일 1개를 반드시 포함한다.
2. 현재 기본값 재현
   - 현재 설정 그대로 STT 결과를 저장한다.
   - 사용된 모델, 전처리 plan, 청크 길이, 처리 시간을 함께 기록한다.
3. 전처리 off 비교
   - `preprocessing.enabled=false` 또는 `normalization_mode=off` 기준을 만든다.
   - 현재 결과보다 원본/off가 좋으면 전처리 회귀로 판단한다.
4. `noise_gate=false` 단독 비교
   - 다른 설정은 그대로 두고 `noise_gate`만 끈다.
   - 한국어 자음, 받침, 말끝, 짧은 맞장구, 작은 목소리 회복 여부를 본다.
5. 청크 길이 비교
   - 30초, 60초, 90초를 비교한다.
   - 긴 파일 처리 시간과 품질을 같이 본다.
6. 화자 정렬 영향 분리
   - STT 원문이 나쁜지, STT 원문은 괜찮은데 화자/문장 정렬에서 나빠지는지 분리한다.
   - `segments` 원문과 `speakerSegments` 결과를 따로 확인한다.
7. 대체 STT 비교
   - Cohere 결과가 계속 나쁘면 faster-whisper-large-v3를 같은 샘플로 비교한다.
   - 비교 기준은 한국어 회의 정확도, timestamp/diarization 정합성, 처리시간, 로컬 배포 난이도다.

즉시 보수적 조치 후보:

- 새 비교 전까지 `noise_gate`를 기본값에서 끄는 방향을 우선 검토한다.
- `noise_gate`는 "방송 오프닝/저음량 잡음 보정용 선택 옵션"으로 남기고, 기본 회의 인식에는 자동 적용하지 않는 편이 안전하다.

결과 기록 방식:

- 자동 평가 결과는 `backend/temp/audio_performance_eval/` 아래 JSON으로 남긴다.
- 판단과 교훈은 이 문서에 누적한다.
- 기준 샘플 목록은 `docs/audio-testset-manifest.csv`에 고정한다.

### 2026-05-07 1차 확인: noise gate 회귀

사용한 샘플:

- `Smart Minutes AI/backend/temp/20260506_072159_upload.mp4`
- 앞 60초만 추출해 비교
- 평균 음량: -27.8 dB
- 결과 JSON: `backend/temp/audio_performance_eval/regression_20260507_manifest_gate_compare.json`

비교 결과:

| 모드 | 적용 결과 | 글자 수 | 미리보기 판단 |
| --- | --- | ---: | --- |
| `off` | 정규화 없음 | 448 | 초반 대부분이 `Taske Jongang`, `standing Toron` 같은 로마자식 오인식 |
| `current_default` | `noise_gate=true` + `loudnorm` | 494 | 일부 한글이 나오지만 로마자식 오인식이 많이 남음 |
| `auto_no_gate` | `noise_gate=false` + `loudnorm` | 643 | 한글 문장 비율이 뚜렷하게 증가. 일부 고유명사/영어식 오인식은 남음 |

판단:

- 이 샘플에서는 `noise_gate`가 STT 품질을 개선하지 못했고, 오히려 한글 전사량과 자연스러운 문장 비율을 낮췄다.
- `noise_gate`는 방송 오프닝 일부에는 효과가 있었지만, 기본 회의 인식에 항상 켜두기에는 회귀 위험이 크다.
- 개발 설정, Tauri 리소스 설정, 현재 portable 실행 폴더 설정에서 `preprocessing.noise_gate=false`로 되돌렸다.
- 다음 비교는 청크 길이 30초/60초/90초와 화자 정렬 영향을 분리해서 진행한다.

### 2026-05-07 2차 확인: 장문 STT 청크 길이

사용한 샘플:

- `Smart Minutes AI/backend/temp/20260506_072159_upload.mp4`
- 앞 90초를 추출한 뒤 `noise_gate=false`, `normalization_mode=auto`로 전처리
- 결과 JSON: `backend/temp/audio_performance_eval/chunk_regression_20260507.json`

비교 결과:

| 실제 STT 입력 청크 | 청크 수 | 글자 수 | 한글 비율 | 판단 |
| ---: | ---: | ---: | ---: | --- |
| 30초 | 3 | 376 | 3.5% | 로마자식 오인식이 대부분 |
| 60초 | 2 | 649 | 17.9% | 한글 문장이 늘지만 영어식 표기가 많음 |
| 90초 | 1 | 767 | 54.3% | 가장 많은 한글 문장과 문맥을 유지 |

판단:

- Cohere는 너무 짧은 30초 입력에서 한국어 회의/방송 맥락을 잃고 로마자식 전사를 많이 만들었다.
- 긴 파일 처리용 실제 STT 청크는 30초보다 90초가 안전하다.
- `processing.long_audio_chunk_seconds`를 90초로 올렸다.
- `stt.chunk_seconds`는 전사 후 화면/화자정렬용 세그먼트 분할 값이므로 일단 30초로 유지한다.

### 2026-05-07 3차 확인: 실제 API 분석 결과

사용한 방법:

- 최신 임시 업로드 `Smart Minutes AI/backend/temp/b30367b5-1d3f-4ee7-a467-75430af4be13_upload.mp4`에서 앞 90초 WAV를 추출
- 실행 중인 portable 백엔드 `http://127.0.0.1:17864/api/analyze`에 실제 `mode=real` 요청
- 결과 JSON: `backend/temp/api_quality_test/api_analyze_90s_result.json`
- 직접 Cohere 옵션 비교: `backend/temp/api_quality_test/direct_cohere_variants.json`

실제 API 결과:

- 분석은 완료됐다.
- 세그먼트 수: 15
- 전사 글자 수: 718
- 한글/라틴 문자 기준 한글 비율: 37.8%
- 앞부분 30초는 한국어 문장이 비교적 잘 나온다.
- 30초 이후부터 `Uriga`, `Ku`, `Yagir`, `Browjo` 같은 로마자식 한국어 전사가 섞인다.

직접 옵션 비교:

| 입력/옵션 | 한글 비율 | 글자 수 | 판단 |
| --- | ---: | ---: | --- |
| 원본, punctuation on | 38.0% | 718 | 앱 결과와 유사. 후반 로마자식 전사 남음 |
| 원본, punctuation off | 21.8% | 1131 | 더 나쁨. 로마자식 전사 증가 |
| `auto_no_gate`, punctuation on | 37.8% | 718 | 현재 기본값과 동일 수준 |
| `auto_no_gate`, punctuation off | 22.6% | 1124 | 더 나쁨 |
| `loudnorm_no_gate`, punctuation on | 37.8% | 718 | `auto_no_gate`와 동일 |

판단:

- `noise_gate=false`와 90초 청크는 회귀를 줄였지만, 이 샘플의 후반부 로마자식 전사는 Cohere 모델 자체의 한계로 남는다.
- `punctuation=false` 재시도는 이 샘플에서 오히려 품질을 낮췄다.
- 볼륨 정규화 on/off보다 STT 모델 선택의 영향이 더 크다.
- 현재 로컬에는 faster-whisper 모델 파일이 없고, 라이브러리만 설치되어 있다. 대체 STT 품질 비교를 하려면 `faster-whisper-large-v3` 등 실제 모델 파일을 별도로 준비해야 한다.

다음 조치 후보:

1. `faster-whisper-large-v3`를 별도 후보 모델로 받아 같은 90초/긴 파일 샘플에서 비교한다.
2. Cohere를 유지한다면, 사용자가 결과 화면에서 "인식 품질 낮음/로마자식 오인식 많음"을 알 수 있게 품질 경고를 추가한다.
3. 회의록 생성 전 단계에 "대화록 확인 후 AI 정리 생성" 흐름을 강화한다.
4. 로마자식 한국어 후처리는 자동 교정 후보로 둘 수 있지만, 오교정 위험이 높으므로 기본 자동 수정으로 넣지 않는다.

### 2026-05-07 4차 확인: faster-whisper-large-v3 30초 smoke

중단됐던 작업:

- `faster-whisper-large-v3`를 `device=auto`, `compute_type=auto`, `beam_size=5`로 30초 샘플에 실행했으나 10분 안에 완료되지 않았다.
- 남은 프로세스를 종료하고, 실행 조건을 보수적으로 낮춰 재시도했다.

성공한 조건:

- 모델: `backend/models/stt/faster-whisper-large-v3`
- 샘플: `backend/temp/asr_benchmark/latest_temp_upload/latest_temp_upload_0s_30s.wav`
- 실행: CPU, int8, beam size 1
- 결과 JSON: `backend/temp/asr_benchmark/faster_whisper_large_v3_30s_cpu_int8.json`

결과:

| 항목 | 값 |
| --- | ---: |
| 처리 시간 | 15.45초 |
| 전사 글자 수 | 221자 |
| 한글 비율 | 98.8% |

미리보기:

`5개의 정당 대선 후보가 TV 스탠딩 토론을 마쳤습니다. 우리나라 대선에서 처음으로 진행된 스탠딩 토론이었는데 어떻게 보셨습니까? ...`

판단:

- 같은 TV 토론 샘플에서 Cohere가 `Taskejong`, `standing Toron`처럼 로마자식 한국어를 만들던 문제를 faster-whisper는 크게 줄였다.
- CPU int8/beam1 조건은 속도와 품질이 모두 비교 가능한 수준이다.
- 현재 PC에서는 `auto/CUDA` 탐색보다 CPU int8 고정이 테스트 안정성이 높다.
- 다음은 같은 조건으로 90초, 다른 샘플 2~3개, 화자 정렬 영향을 비교한다.

### 2026-05-07 5차 확인: faster-whisper-large-v3 90초 비교

같은 TV 토론 샘플의 앞 90초를 CPU int8, beam size 1로 추가 실행했다.

결과 JSON:

- `backend/temp/asr_benchmark/faster_whisper_large_v3_90s_cpu_int8.json`

결과:

| 항목 | 값 |
| --- | ---: |
| 처리 시간 | 213.86초 |
| 전사 글자 수 | 963자 |
| 한글 비율 | 99.7% |

미리보기:

`5개의 정당 대선 후보가 TV 스탠딩 토론을 마쳤습니다. 우리나라 대선에서 처음으로 진행된 스탠딩 토론이었는데 어떻게 보셨습니까? ...`

판단:

- 품질만 보면 Cohere보다 훨씬 안정적이다. 로마자식 한국어 오인식이 거의 사라졌다.
- 다만 90초 처리에 213.86초가 걸려 실시간보다 약 2.4배 느리다.
- 회의록 품질 우선 모드 후보로는 강력하지만, 긴 파일 기본값으로 쓰려면 GPU/양자화/더 작은 모델/청크 병렬화 검토가 필요하다.
- 개발 UI의 `ASR 테스트 결과` 화면에서 해당 JSON이 바로 표시된다.

### 2026-05-07 6차 확인: Qwen3-ASR-1.7B CPU 비교

공식 Qwen3-ASR 모델 카드와 PyPI 패키지를 확인한 뒤, 별도 Python 3.12 환경에서 테스트했다.

확인한 기준:

- PyPI `qwen-asr`: `0.0.6`
- 모델: `backend/models/stt/Qwen3-ASR-1.7B`
- 보조 timestamp 모델: `backend/models/stt/Qwen3-ForcedAligner-0.6B`
- 실행 환경: CPU 전용, `dtype=float32`, `device_map=cpu`, `max_inference_batch_size=1`
- 공식 문서의 기본 예시는 GPU `bfloat16` 기준이므로, 현재 PC에서는 CPU 설정으로 낮춰 실행했다.

결과 JSON:

- `backend/temp/asr_benchmark/qwen3_asr_30s_cpu.json`
- `backend/temp/asr_benchmark/qwen3_asr_90s_cpu.json`
- `backend/temp/asr_benchmark/qwen3_asr_aligner_30s_cpu.json`

결과:

| 모델 | 길이 | 처리 시간 | 전사 글자 수 | 한글 비율 | 세그먼트 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qwen3-ASR-1.7B | 30초 | 51.16초 | 226자 | 98.8% | 1개 |
| Qwen3-ASR-1.7B | 90초 | 123.64초 | 610자 | 99.6% | 1개 |
| Qwen3-ASR-1.7B + ForcedAligner | 30초 | 58.07초 | 226자 | 98.8% | 75개 |

판단:

- 같은 샘플에서 Cohere의 후반부 로마자식 한국어 붕괴는 Qwen3-ASR에서 재현되지 않았다.
- 90초 CPU 실행은 faster-whisper CPU int8보다 빨랐다. 다만 기본 Qwen3-ASR 결과는 전체 텍스트 1개 세그먼트라 화자 정렬에 바로 쓰기 어렵다.
- ForcedAligner를 붙이면 단어/짧은 단위 timestamp가 나오지만, 화자별 회의록에는 너무 잘게 쪼개질 수 있으므로 문장 단위 병합 로직이 필요하다.
- Qwen3-ASR과 ForcedAligner는 모델 폴더를 분리해서 보관하는 방식이 포터블 앱 구조에 적합하다.

### 2026-05-07 7차 확인: Cohere 전처리 제거 비교

사용자 질문:

- 처음 테스트 때는 앞부분만 나쁘고 뒤는 괜찮았던 것 같은데, 현재 성능 개선 처리가 오히려 Cohere 품질을 낮추는지 확인해야 한다.

비교 조건:

- 샘플: `Smart Minutes AI/backend/temp/20260506_072159_upload.mp4`
- 구간: 앞 90초
- 모델: `Smart Minutes AI/models`의 Cohere Transcribe
- 결과 JSON: `backend/temp/api_quality_test/cohere_no_processing_compare_tv_90s.json`

결과:

| 조건 | 처리 내용 | 글자 수 | 한글 비율 | 판단 |
| --- | --- | ---: | ---: | --- |
| `raw_no_preprocess` | 기본 WAV 변환만 수행 | 721자 | 47.4% | 초반 로마자식 한국어가 매우 많음 |
| `off_convert_only` | 전처리 off 변환 | 721자 | 47.4% | raw와 동일 |
| `auto_no_gate` | loudnorm, noise gate 없음 | 767자 | 54.3% | 가장 나음. 그래도 초반 로마자식 오인식이 남음 |
| `noise_gate_on` | loudnorm + noise gate | 796자 | 45.8% | 오히려 나쁨 |

판단:

- “성능 개선 처리 때문에 Cohere가 나빠졌다”라고 보기는 어렵다. 전처리를 완전히 빼도 초반 로마자식 한국어가 크게 남는다.
- 다만 `noise_gate_on`은 이 샘플에서 확실히 악화 요인이므로 기본값에서 제외하는 판단을 유지한다.
- `auto_no_gate` loudnorm은 raw보다 전체 한글 비율을 조금 올리지만, Cohere 자체의 초반/저음량/방송 오프닝 취약성을 해결하지는 못한다.
- Cohere는 회의록 품질 우선 기본 모델 후보에서 제외하고, Qwen3-ASR/faster-whisper 쪽을 계속 검토한다.

## 8. 관련 문서

- 전처리 현황: `docs/audio-preprocessing-notes.md`
- 테스트 계획: `docs/audio-preprocessing-test-plan.md`
- 평가 템플릿: `docs/audio-preprocessing-eval-template.csv`
- 즉시 실행 목록: `todo.md`

### 2026-05-07 Qwen 반복 문장 정리

- 증상: Qwen3-ASR 결과에서 인접 문장이 반복되거나, 샘플 끝부분에서 앞 문장이 다시 반복되는 경우가 확인됨.
- 조치: `backend/pipeline/qwen_segments.py`에 보수적인 반복 문장 제거 로직을 추가함.
- 범위: 바로 앞 문장과 완전히 같은 반복, 마지막 문장이 앞서 나온 문장으로 되돌아가는 반복만 제거함.
- 의도: 실제 회의에서 같은 말을 반복하는 경우까지 과하게 지우지 않기 위해 의미 유사도 기반 삭제는 적용하지 않음.
- UI 확인: 개발용 ASR 비교 회의 기록은 기존 항목도 덮어써서 반복 제거 결과를 바로 확인할 수 있게 함.

### 2026-05-07 Hermes Agent 90초 비교

- 샘플: `Smart Minutes AI/video/[Hermes Agent] 기억하고 진화하는 AI 헤르메스 에이전트 ... .mp4`
- 구간: 앞 90초
- faster-whisper 결과 파일: `backend/temp/asr_benchmark/hermes_faster_whisper_90s_compare.json`
- Qwen 결과 파일: `backend/temp/asr_benchmark/hermes_qwen3_90s_compare.json`

| 모델 | 처리 시간 | 한글 비율 | segment | 관찰 |
| --- | ---: | ---: | ---: | --- |
| faster-whisper-large-v3 | 72.50초 | 98.9% | 17개 | 빠르고 발화 경계가 실용적임. 일부 고유명사/제품명 오인식 있음 |
| Qwen3-ASR + ForcedAligner | 287.41초 | 98.9% | 표시 26개 | 한글 비율은 같지만 CPU 처리 시간이 훨씬 큼. 일부 단어 선택과 띄어쓰기 확인 필요 |

- 판단: 이 샘플에서도 포터블 데스크톱 기본 후보는 faster-whisper 쪽이 더 실용적이다.
- UI 확인: 개발 모드 회의 기록에 `ASR 비교 Hermes 90초 - faster-whisper`, `ASR 비교 Hermes 90초 - Qwen` 항목을 추가했다.

### 2026-05-08 긴 파일 진행률 안정화: 외부 청크 기본값 30초

- 증상: 웹/데스크탑 공통 분석 흐름에서 긴 Hermes 영상이 `Transcribing chunk 1/18...` 상태로 오래 머물러 사용자가 멈춘 것으로 인식할 수 있었다.
- 조치: `processing.long_audio_chunk_seconds` 기본값을 90초에서 30초로 낮추고, 런타임 fallback과 Tauri resource config도 같은 값으로 맞췄다.
- 리팩토링: STT/청크 기본값과 legacy Cohere 설정 보정을 `backend/config_normalization.py`로 분리했다. 분석 job 등록/취소/정리는 `backend/analysis_jobs.py`로 분리했다.
- 검증: `python -m unittest backend.test_api tests.test_export_record`, `pnpm --dir desktop-app run typecheck`, backend/Tauri resource Python compile 확인.
- 주의: 30초 청크는 진행 표시와 취소 체크 빈도를 개선하기 위한 1차 안정화다. STT 품질, 문장 경계, 화자 정렬, 전체 처리 시간은 30초/90초 비교 평가로 다시 확인해야 한다.
### 2026-05-08 정정: 외부 청크 기본값은 90초 유지

- 추가 확인: Hermes 90초 샘플에서 외부 청크 30초는 진행 이벤트 빈도에는 유리할 수 있지만, 전사 시간이 90초 조건보다 느렸다. 60초 조건은 해당 샘플에서 비정상적으로 더 느렸다.
- 판단: 앞서 보인 10분 이상 정지는 청크 길이 자체보다 STT 내부 호출 정지, 요청 연결 중단, 또는 진행 이벤트 공백 문제에 가깝다.
- 조치: `processing.long_audio_chunk_seconds` 기본값은 90초로 되돌렸다. 대신 SSE 스트림이 15초 동안 새 진행 이벤트를 받지 못하면 마지막 진행 상태를 heartbeat로 다시 보내도록 했다.
- 남은 과제: 진짜 강제 중단이 필요하면 STT 호출을 subprocess로 분리하고, job timeout/kill 정책을 별도로 설계해야 한다.

### 2026-05-09 진행 시간 표시와 첫 청크 정지 후속 확인

- 증상: 포터블/웹 UI가 `Transcribing chunk 1/18...` 상태로 여러 분 동안 유지됐다. 백엔드는 `/api/health`에 응답했지만 사이드카 CPU 증가가 거의 없어, 정상적인 장시간 처리보다 STT 내부 호출 정지에 가까운 상태로 판단했다.
- UI 조치: 내부 퍼센트를 사용자 진행률처럼 보여주지 않고, 경과 시간과 예상 남은 시간을 표시하도록 바꿨다. 왼쪽 사이드바의 분석 알림은 `새 회의록 작성` 아래, 회의 기록 목록 위에 유지한다.
- 안정화 조치: 기본 외부 STT 청크 길이를 다시 30초로 낮췄다. 대상은 런타임 config, 정규화 기본값, Tauri resource config다. 90초 조건의 품질/처리시간 이점보다 진행 표시와 취소 응답성을 우선한 결정이다.
- 남은 위험: faster-whisper 네이티브 호출 내부에서 멈추면 Python thread cancellation만으로 안전하게 끊을 수 없다. 진짜 강제 timeout은 STT 청크 실행을 별도 subprocess/job worker로 분리한 뒤 kill 정책을 붙여야 한다.
- 추가 확인: 같은 30초 청크를 별도 Python 프로세스에서 기본 faster-whisper 설정으로 실행하면 120초 안에 끝나지 않았다. 반면 `cpu_threads=4`, `num_workers=1`로 제한하면 17.46초에 정상 완료됐다.
- 조치: faster-whisper CPU 실행 시 `cpu_threads=4`, `num_workers=1`을 적용했다. 현재 멈춤의 핵심 원인은 청크 길이보다 ctranslate2/faster-whisper 기본 CPU 스레드 설정과 Windows/포터블 환경의 조합으로 본다.

### 2026-05-10 빈 전사 결과 후속 정리

- 재현: `backend/test_audio.wav`를 실제 `/api/analyze` 경로로 실행했을 때, STT가 빈 segment 목록을 반환한 뒤에도 파이프라인이 diarization 단계로 계속 들어가 수분 동안 heartbeat만 보내다가 stall timeout으로 종료됐다.
- 분리 확인: 같은 샘플에서 diarization을 끄면 `Transcribing chunk 1/1...` 이후 4초 안팎에 다음 단계로 진행했고 전체 요청도 20초 이내에 종료됐다.
- 원인 판단: 업로드나 SSE 전달 문제가 아니라, `segments=[]`인 경우에도 diarization/summary를 계속 시도한 파이프라인 분기와 동일한 faster-whisper 경로를 fallback으로 한 번 더 재시도하는 흐름이 사용자의 "청크에서 멈춤" 체감에 기여했다.
- 조치: transcript segment가 비어 있으면 diarization과 summary를 건너뛰고 사용자용 안내 문구와 함께 바로 결과를 저장하도록 변경했다. 또 primary STT 경로와 fallback 경로가 같으면 중복 재시도를 하지 않도록 막았다.

### 2026-05-10 auto GPU preflight for faster-whisper

- 재현: `portable_video_15s.mp4`를 `/api/analyze`로 올리면 `Transcribing chunk 1/1...` 단계에서 오래 머문 뒤 stall timeout으로 끝나는 경우가 있었다.
- 분리 확인: `transcribe_audio_fallback_whisper(..., device="auto")`를 직접 실행하면 처음 GPU 경로에서 `cublas64_12.dll` 오류가 난 뒤 CPU 재시도로 성공했다. 같은 파일을 `device="cpu"`로 실행하면 약 10초 안에 끝났다.
- 원인 판단: Windows에서 GPU는 감지되지만 필요한 CUDA DLL(`cublas64_12.dll`, `cudnn64_9.dll`)이 없는 환경에서는 doomed GPU attempt가 먼저 발생했다.
- 조치: `backend/pipeline/transcribe.py`에서 `device="auto"`일 때 Windows CUDA DLL preflight를 추가했다. DLL이 없으면 GPU 시도를 건너뛰고 바로 CPU로 내려간다.
- 검증: 단위 테스트에 Windows DLL 누락 시 `auto -> cpu` 직행 케이스를 추가했고, 동일 샘플의 direct transcribe에서도 CPU 경로가 정상 완료되는 것을 확인했다.

### 2026-05-10 CPU 기본값 전환과 GPU 사용 가드

- 결정: 기본 분석 장치는 `cpu`로 둔다. GPU는 감지되더라도 자동 사용하지 않는다.
- 조치: 설정 정규화와 기본 `config.json`의 STT 장치를 `cpu`로 바꿨다. 기존 `auto` 설정도 저장 시점에 `cpu` 기준으로 정규화한다.
- 조치: `/api/models/status`에 GPU 사용 가능 여부를 함께 내려서, 설정 UI에서는 CUDA 실행 조건이 준비된 경우에만 GPU 선택을 허용한다.
- 후속: 단순 감지보다 강한 “GPU 사전 점검 버튼”은 별도 작업으로 `roadmap.md`에 남겼다.

## 2026-05-10 Build Gate Recheck

- Automated gates passed:
  - `python -m unittest backend.test_api tests.test_export_record tests.test_align_speakers tests.test_qwen_segments tests.test_portable_release_scripts`
  - `pnpm --dir desktop-app run typecheck`
  - `pnpm --dir desktop-app run lint`
  - `pnpm --dir desktop-app run test:generation-flow`
  - `APP_URL=http://127.0.0.1:4173 pnpm --dir desktop-app run test:meeting-detail-flow`
  - `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify_portable.ps1 -PortableDir D:\Projects\audio\lmo_audio`
- Real analyze is still blocking the portable build:
  - sample: `tmp/portable_video_15s.mp4`
  - config intent: `stt.selected_model=faster-whisper-large-v3`, `stt.device=cpu`, `diarization.enabled=false`
  - clean SSE timing: `Converting to WAV...` at 13.13s, `Transcribing chunk 1/1...` until 551.97s, `Summarizing with Local LLM...` about 14s, final completed event at 567.84s
  - later clean rerun returned HTTP 200 after 645.06s without `status=completed`
- Code change during this round:
  - added faster-whisper model reuse cache in `backend/pipeline/transcribe.py`
  - added cache regression tests in `backend/test_api.py`
- Current blocker assessment:
  - caching alone did not recover acceptable CPU latency on this machine
  - next checks should compare a smaller whisper profile or a different faster-whisper runtime/dependency set before starting a portable build

## 2026-05-11 기준선 재정리와 venv 상태 확인

- 배포 기준 이름을 코드 자동화에 맞춰 `lmo_audio` / `lmo_audio.exe`로 고정했다. `Smart Minutes AI`는 제품/문서 제목으로 남을 수 있지만, 실제 portable 실행 폴더 기준으로는 쓰지 않는다.
- 기본 STT 기준은 `faster-whisper-large-v3`로 둔다. Cohere는 품질 문제 때문에 기본 후보에서 제외하지만, 관련 코드와 기록은 삭제하지 않고 과거 비교/벤치마크 후보로 보존한다.
- 개발 루틴은 프론트와 백엔드를 분리한다. 프론트는 `desktop-app`에서 `corepack pnpm run dev`, 백엔드는 `scripts/start_dev_backend.ps1`로 `127.0.0.1:17863`에 띄운다.
- 추가 진단: 현재 `backend\.venv`는 `C:\Users\MS\AppData\Local\Programs\Python\Python311`, `backend\.venv-asr-faster-whisper`는 `C:\Users\MS\AppData\Local\Programs\Python\Python312`를 가리키지만, 이 Python 실행 파일들이 현재 PATH/파일 시스템에서 잡히지 않아 venv 실행이 실패한다.
- 판단: 다음 faster-whisper 지연 재검증 전에 개발용 backend venv와 ASR 전용 venv를 현재 PC의 실제 Python 런타임으로 재구성해야 한다. 지금 바로 STT 속도 비교를 실행하면 런타임 복구 문제와 모델 성능 문제가 섞인다.
- 복구: 기존 `backend\.venv*` 폴더를 삭제하고, Codex 번들 Python 3.12.13 기준으로 `backend\.venv`와 `backend\.venv-asr-faster-whisper`를 새로 만들었다.
- 검증: `backend\.venv`는 `fastapi`, `uvicorn`, `faster_whisper`, `ctranslate2`, `torch`, `cohere` import와 `pip check`를 통과했다. ASR 전용 venv도 `faster_whisper`, `ctranslate2`, `numpy`, `WhisperModel` import와 `pip check`를 통과했다.
- 검증: `scripts\start_dev_backend.ps1` 실행 후 `/api/health`가 `backend_dir=D:\Projects\audio\backend`, `python_executable=D:\Projects\audio\backend\.venv\Scripts\python.exe`로 응답했다.
- 제외: `llama-cpp-python`은 Windows 긴 경로 문제로 전체 requirements 설치를 막았으므로 기본 requirements에서 분리했다. 현재 요약 기본 경로는 Ollama provider이고, GGUF 직접 실행이 필요할 때만 `backend\requirements-llama.txt`와 `scripts\setup_llama_cpp_env.ps1`로 짧은 경로의 별도 환경에 설치한다.
- 재검증: 새 ASR venv에서 `scripts\run_asr_benchmark.py --engines faster-whisper-large-v3 --sample-seconds 15 --manifest docs\audio-testset-manifest.csv`를 먼저 실행했을 때 벤치 스크립트가 앱과 달리 `cpu_threads=4`, `num_workers=1`을 넘기지 않아 15초 샘플이 207.60초 걸렸다.
- 조치: `configs/asr-models.json`과 `scripts\run_asr_benchmark.py`를 앱 런타임과 맞춰 CPU에서 `cpu_threads=4`, `num_workers=1`을 쓰도록 정렬했다.
- 재검증: 같은 15초 샘플은 `device=cpu`, `compute_type=int8`, `cpu_threads=4`, `num_workers=1` 조건에서 9.88초에 완료됐다. 즉 이번 지연 재현의 직접 원인은 venv 자체보다 벤치/실행 경로의 faster-whisper CPU worker 설정 불일치였다.
- `llama-cpp-python` 추가 확인: agent 검토 결과 현재 기본 요약 경로는 Ollama이고, `backend/pipeline/summarize.py`는 GGUF/BIN 파일 경로를 직접 지정할 때만 `llama_cpp`를 import한다. 따라서 기능은 삭제하지 않고 선택 의존성으로 분리한다.
- `llama-cpp-python` 설치 시도: `C:\tmp\lmo-llama-venv`와 `C:\tmp\lmo-pip-temp`처럼 짧은 경로를 사용해도 sdist 내부의 긴 경로 때문에 실패했다. 이 PC는 `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled=0`이고, 현재 권한으로 HKLM 값을 바꾸지 못했다. `scripts\setup_llama_cpp_env.ps1`는 이제 시작 전에 이 조건을 확인하고 명확히 실패한다.
- 실제 backend 검증: `video\portable_video_15s.mp4`를 `/api/analyze` real SSE 경로로 실행했을 때 17.73초에 완료됐고, JSON/TXT/MD/DOCX/HWPX 출력이 생성됐다.
- portable 1차 검증: `scripts\release_portable.ps1 -SkipSidecarBuild -SkipTauriBuild`로 `lmo_audio`를 재구성하면 기본 구조/모델/health/export smoke는 통과했지만, deploy sidecar의 실제 `/api/analyze`는 `No module named 'unicodedata'`로 실패했다. 이는 웹/backend 문제가 아니라 오래된 PyInstaller sidecar의 표준 확장 모듈 누락이었다.
- 조치: `scripts\package_backend_sidecar.ps1`에 `--hidden-import unicodedata`와 빌드 후 `unicodedata*.pyd` 존재 검증을 추가했다. 새 `backend\.venv`에 `backend\requirements-desktop.txt`의 PyInstaller 빌드 의존성을 설치하고 sidecar를 재빌드했다.
- portable 재검증: `scripts\release_portable.ps1 -SkipTauriBuild -Python D:\Projects\audio\backend\.venv\Scripts\python.exe`가 통과했고, deploy 폴더 `lmo_audio`의 sidecar로 같은 15초 샘플을 실제 `/api/analyze`에 넣었을 때 35.41초에 완료됐다. 첫 실행 모델 로딩 때문에 dev backend보다 느리지만, 500초대 stall과 `unicodedata` 오류는 재현되지 않았다.
