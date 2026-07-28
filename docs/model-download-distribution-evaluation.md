# 모델 다운로드 배포 검토

- 작성일: 2026-07-17
- 대상 모델: pyannote `speaker-diarization-community-1`
- 관련 문서: `docs/speaker-diarization-model-evaluation.md`

## 결론

모델 파일 배포에는 Google Drive보다 Cloudflare R2 Standard가 적합하다.
데스크톱 앱 또는 로컬 동반 프로그램이 모델을 최초 1회 직접 다운로드하고
검증 후 로컬에 캐시하는 구조를 사용한다.

기관 업무망에서 외부 인터넷이 차단될 수 있으므로 R2 경로 외에 오프라인
모델 패키지와 기관 내부 파일 서버 미러도 제공한다.

## 실제 용량

- 현재 로컬 Community-1 모델은 11개 파일, 총 33,695,880바이트
  (약 32.13MiB)다.
- embedding 가중치: 약 25.41MiB
- segmentation 가중치: 약 5.63MiB
- 가중치는 작지만 Python, PyTorch, pyannote 실행 환경은 별도다.

순수 웹 브라우저에 이 파일들을 다운로드하는 것만으로는 pyannote를 실행할
수 없다. 브라우저 실행에는 segmentation, embedding, PLDA/VBx 파이프라인
전체를 ONNX/WebGPU 등의 브라우저 런타임으로 별도 이식해야 한다.

## 권장 다운로드 흐름

1. 앱이 로컬 manifest와 모델 폴더를 확인한다.
2. 모델이 없거나 버전이 다를 때만 서버에 다운로드 URL을 요청한다.
3. 클라이언트가 R2에서 버전별 패키지를 직접 다운로드한다.
4. SHA-256과 파일 크기를 검증한다.
5. 검증된 패키지를 원자적으로 모델 폴더에 설치한다.
6. 이후에는 로컬 모델을 사용하며 매번 다시 다운로드하지 않는다.

파일명 예:

`pyannote-community-1/2026-07/model-windows-x64.zip`

manifest에는 버전, 다운로드 URL, 전체 크기, SHA-256, 라이선스와 고지문
버전을 포함한다.

## Cloudflare R2 비용

2026-07 기준 R2 Standard 요금:

- 저장: 월 10GB-month 무료, 이후 $0.015/GB-month
- Class A: 월 100만 요청 무료, 이후 $4.50/100만 요청
- Class B GET: 월 1,000만 요청 무료, 이후 $0.36/100만 요청
- 인터넷 egress: 무료

약 32.13MiB의 패키지 하나를 기준으로:

| 월 최초 다운로드 | 전송량 | GET 요청 | 예상 R2 비용 |
|---:|---:|---:|---:|
| 1,000회 | 약 31.4GiB | 1,000 | 무료 구간 |
| 10,000회 | 약 313.8GiB | 10,000 | 무료 구간 |
| 100,000회 | 약 3.06TiB | 100,000 | 무료 구간 |
| 1,000,000회 | 약 30.6TiB | 1,000,000 | 무료 구간 |

위 계산은 R2 Standard의 모델 파일 하나와 직접 다운로드만 포함한다.
Cloudflare Workers, Access, 유료 WAF, 별도 서버 프록시 등의 비용은
별도다. 자체 서버로 파일을 중계하지 않고 클라이언트가 R2에서 직접 받게
해야 자체 서버 트래픽 비용이 발생하지 않는다.

## R2 공개·기관 제한 방식

### 공개 배포

- R2에 custom domain을 연결한다.
- 버전이 포함된 불변 파일명과 장기 `Cache-Control`을 사용한다.
- `r2.dev`는 개발용이므로 운영에 사용하지 않는다.
- 모델 패키지는 512MB 이하라 일반 Cloudflare 캐시 크기 제한 안에 든다.

### 기관 사용자 전용

- private bucket을 유지한다.
- 로그인한 사용자에게 짧은 만료시간의 presigned GET URL을 발급하거나
  Cloudflare Access와 기관 SSO를 사용한다.
- presigned URL은 만료 전까지 URL을 가진 사람이 사용할 수 있는 bearer
  token이므로 짧게 발급하고 로그에 전체 URL을 남기지 않는다.
- 기관 방화벽에는 Google Drive가 아니라 제품용 custom domain 하나를
  허용 목록으로 요청하는 편이 관리하기 쉽다.

## Google Drive를 사용하지 않는 이유

- Google Drive는 모델 CDN이나 소프트웨어 업데이트 서버가 아니다.
- 기관 관리자가 외부 공유, 다운로드, 신뢰 도메인을 제한할 수 있다.
- 업무망 또는 외부 계정에서 로그인·쿠키·공유 정책 때문에 자동 다운로드가
  실패할 수 있다.
- 동일 파일에 다운로드가 집중되면 일시적인 다운로드 제한이 발생할 수 있다.
- 안정적인 manifest, CORS, 캐시, 버전별 불변 URL, 자동 업데이트를
  운영하기 어렵다.

## 업무망 대안

외부 인터넷 접속이 차단된 기관에는 다음 중 하나를 제공한다.

- 모델 포함 오프라인 설치 패키지
- 관리자용 모델 가져오기 기능
- 기관 내부 HTTP 파일 서버 또는 아티팩트 저장소 미러
- SHA-256이 포함된 오프라인 검증 manifest

## 라이선스와 gated 접근

- Community-1 모델은 CC BY 4.0으로 복사와 재배포가 허용되지만 출처,
  라이선스 링크, 변경 여부 표시가 필요하다.
- 공식 Hugging Face 저장소는 사용자별 연락처 동의를 요구하는 gated
  저장소다.
- 공개 R2 미러는 공식 사용자별 접근 절차를 우회하게 된다.
- 일반 공개 서비스에서 직접 미러링하기 전에는 pyannote 측의 서면 확인
  또는 법무 검토를 받는다.
- 확인 전에는 기관 사용자만 접근 가능한 저장소를 사용하거나 사용자가
  공식 Hugging Face 절차를 거치게 한다.

## 참고 자료

- Cloudflare R2 요금:
  https://developers.cloudflare.com/r2/pricing/
- R2 공개 버킷과 custom domain:
  https://developers.cloudflare.com/r2/buckets/public-buckets/
- R2 presigned URL:
  https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- R2 브라우저 CORS:
  https://developers.cloudflare.com/r2/buckets/cors/
- Google Drive 보안 제한:
  https://support.google.com/drive/answer/15697599
- Hugging Face gated 모델:
  https://huggingface.co/docs/hub/models-gated
- pyannote Community-1:
  https://huggingface.co/pyannote/speaker-diarization-community-1
- CC BY 4.0:
  https://creativecommons.org/licenses/by/4.0/
