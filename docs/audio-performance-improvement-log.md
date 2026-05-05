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

목적:

- 같은 샘플에서 `normal / quiet / noise / silence_trim / denoise` 변형을 만든다.
- `auto / loudnorm / speechnorm` 전처리를 같은 방식으로 비교한다.
- 선택적으로 STT와 diarization을 실행해 결과를 JSON으로 남긴다.
- 긴 파일은 일정 길이만 WAV로 추출한 뒤 청크 개수와 임시 파일 용량을 기록한다.

실행한 명령:

```powershell
python scripts\run_audio_performance_eval.py --video-dir "Smart Minutes AI\video" --limit 2 --sample-seconds 60 --run-stt --long-seconds 1800 --output backend\temp\audio_performance_eval\stt_eval_limit2.json
python scripts\run_audio_performance_eval.py --video-dir "Smart Minutes AI\video" --limit 1 --sample-seconds 60 --run-diarization --long-seconds 1800 --output backend\temp\audio_performance_eval\diarization_eval_limit1.json
```

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

## 7. 관련 문서

- 전처리 현황: `docs/audio-preprocessing-notes.md`
- 테스트 계획: `docs/audio-preprocessing-test-plan.md`
- 평가 템플릿: `docs/audio-preprocessing-eval-template.csv`
- 즉시 실행 목록: `todo.md`
