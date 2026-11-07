# 데스크톱 업데이트 공개 절차

데스크톱은 `release-manifest.json`의 `commit`과 `generatedAt`으로 빌드를 구분한다. `tauri.conf.json`의 `0.1.0`이나 웹 연결용 설치 엔진 버전으로 비교하지 않는다. 새 빌드는 기존 빌드보다 생성 시각이 늦고 커밋이 다를 때만 안내한다. 같은 커밋 재빌드는 업데이트로 안내하지 않는다. 개발 실행·dirty 빌드·빌드 정보가 없는 설치본은 자동 비교 대상에서 제외한다.

공개 전에는 `desktop-release.json`의 `release`를 `null`로 둔다. 이는 **데스크톱 업데이트 패키지를 아직 공개하지 않았다**는 뜻이며 `/downloads/desktop-beta.json`은 404를 반환한다. 설치 엔진 EXE나 신규 설치 패키지로 대신 연결하지 않는다. 아래 준비와 공개 승인을 마치기 전에는 값을 채우지 않는다. 날짜별 공개 상태와 증거는 릴리스 체크리스트가 소유한다.

1. [릴리스 체크리스트](../../docs/release-checklist.md) 6-1절에 따라 소스 검사·독립 검토·커밋 후 깨끗한 portable 빌드를 만든다. 기존 사용자의 모델·설정·기록을 보존한다.
2. `corepack pnpm package:update`로 검증된 빌드 목록에 있는 프로그램 파일만 업데이트 패키지로 만든다. 실제 실행 검사에 쓴 폴더나 `releases/lmo_audio` 전체를 압축하지 않는다.
3. 검증된 업데이트 패키지의 루트에 `update_lmo_audio.ps1`, `verify_update.ps1`, `portable_data_safety.ps1`, `update-manifest.json`, `payload/`가 오도록 ZIP을 만든다. 압축 전후 항목·크기·해시가 업데이트 목록과 일치하는지 확인한다. 사용자 설정·회의 기록·로그·모델·비밀값이 추가로 들어가면 공개하지 않는다.
4. 파일명을 `lmo_audio_update_<40자리 전체 commit>.zip`으로 정하고 ZIP 전체의 바이트 크기와 SHA-256을 기록한다. `commit`·`generatedAt`은 ZIP 안 `payload/release-manifest.json`의 빌드 값을 쓴다. 패키지를 만든 시각으로 바꾸면 안 된다. 공개 전 이전 공개 커밋의 후속 소스인지 확인한다. 클라이언트의 빌드 시각 비교는 Git 이력을 증명하지 않으므로, 과거 소스를 다시 빌드해 새 업데이트로 게시하지 않는다.
5. 사용자 승인 범위에서 기존 R2 배포 절차로 ZIP을 올리고 객체의 `customMetadata.sha256`에 ZIP SHA-256을 설정한다. 원격 파일을 다시 읽어 전체 해시와 크기를 확인한다. 이 문서는 업로드·배포 승인을 대신하지 않는다.
6. 검증한 값으로 `desktop-release.json`을 아래 형태로 작성하고 검토·배포한다. Worker는 JSON을 내주기 전에도 R2 객체의 크기와 SHA-256 메타데이터 일치를 확인한다. 누락·불일치는 503으로 닫힌다. 임의 경로는 다운로드할 수 없다.

```json
{
  "release": {
    "schemaVersion": 1,
    "type": "portable-update",
    "origin": "https://barorok.ecomarin.workers.dev",
    "commit": "빌드의 전체 40자리 소문자 커밋",
    "generatedAt": "빌드 manifest의 시간대가 있는 ISO 시각",
    "downloadPath": "/downloads/lmo_audio_update_<전체 commit>.zip",
    "bytes": 123,
    "sha256": "ZIP 전체의 64자리 소문자 SHA-256"
  }
}
```

위 예시는 형식 설명용이며 유효한 배포 값이 아니다. 공개 후에는 실제 HTTPS에서 메타데이터·HEAD·부분 다운로드·전체 해시, 이전 빌드의 안내, 같은/더 최신 빌드에서 안내하지 않는 동작, 분석 중 다운로드 보류를 확인한다. 업데이트 안내는 사용자가 클릭해야 다운로드한다. 자동 종료·설치·재시작을 하지 않는다. ZIP을 받은 사용자는 작업 저장·앱 종료 후 별도 폴더에 풀고 포함된 업데이트 스크립트로 기존 설치 폴더를 갱신한다. 신규 PC는 신규 설치 패키지를 사용한다.

회수할 때는 `release: null`로 안내를 닫고 승인된 웹 배포 절차를 따른다. 이미 받은 파일이나 PC의 사용자 자료를 삭제하지 않는다. 공개 확인 항목은 `docs/release-checklist.md`의 기존 QA 표에서 관리한다.

계약 검사: `corepack pnpm --dir deploy/cloudflare test`, `node --experimental-strip-types --test desktop-app/scripts/test-desktop-release.mjs`.

## 신규 설치 ZIP과 함께 배포하기

신규 PC에는 `corepack pnpm package:handoff`로 만든 **신규 설치 패키지(ZIP)**를 제공한다. 기존 설치를 갱신하는 업데이트 패키지와 목적·메타데이터·주소를 구분한다. 현재 신규 설치 ZIP에는 기본 설정과 화자 구분 모델이 들어가며 Whisper·Ollama 실행 파일·요약 모델은 따로 준비한다. 사용자 자료가 들어 있는 `releases/lmo_audio` 전체를 압축하지 않는다.

| 용도 | 공개 정보 | R2 객체 키·파일 주소 |
| --- | --- | --- |
| 데스크톱 신규 설치 | `desktop-install-release.json`, `/downloads/desktop-install-beta.json`, `type: portable-install` | `lmo_audio_install_<전체 commit>.zip`, `/downloads/` 아래 같은 이름 |
| 기존 데스크톱 업데이트 | `desktop-release.json`, `/downloads/desktop-beta.json`, `type: portable-update` | `lmo_audio_update_<전체 commit>.zip`, `/downloads/` 아래 같은 이름 |
| 웹 연결용 엔진 | `release.json`, `/downloads/engine-beta.json` | `Barorok-Local-Engine-Setup-<engineVersion>.exe`, `/downloads/` 아래 같은 이름 |

신규 설치 descriptor는 위 업데이트 예시에서 `type`을 `portable-install`, `downloadPath`를 `/downloads/lmo_audio_install_<전체 commit>.zip`으로 바꾼다. 나머지 필드·검증 규칙은 같다. 로컬 신규 설치 ZIP 이름은 `lmo_audio_no_ollama_no_whisper_<7자리 commit>.zip`이며, 업로드할 때만 전체 commit 기반 객체 키를 사용한다. 두 desktop descriptor의 `release:null`은 각각 404다. 엔진 설치 EXE·신규 설치 ZIP을 업데이트 feed로 제공하면 안 된다. 이 경로 추가는 다운로드 페이지의 버튼 추가나 실제 공개를 뜻하지 않는다.

## 2026-10-27 로컬 공개 준비

사용자 요청 범위는 신규 설치 ZIP 생성과 **R2 업로드·웹 배포 준비**다. 실제 업로드·배포·commit·push는 수행하지 않았다. 기존 엔진 공개 정보는 `0.1.12-beta-20261026`, 데스크톱 두 공개 정보는 `release:null`로 보존했다.

후보 묶음은 저장소 루트 기준 `.tmp/publication-20261027`에 있다. `r2-upload-manifest.json`은 실제 파일의 절대 경로·객체 키·바이트 수·SHA-256·콘텐츠 종류·`customMetadata.sha256`을 기록한다. `candidate-manifest.json`은 Worker 소스와 실제 웹 자산 10개의 해시, 데스크톱 빌드 commit `282d5d20c686b742c3ed12f29588efa494d7b687`과 생성 시각, 엔진 `0.1.13-beta-20261027`, 미업로드·미배포·Worker 소스 미커밋·NSIS 실측 대기 상태를 구분한다. 이 후보는 로컬 절대 경로와 원본 공유 모듈을 참조하므로 독립 전달용 배포 아카이브가 아니다. 변경 후에는 후보를 다시 생성·검증한다.

승인된 실제 공개 작업의 순서는 다음과 같다. 이 문서는 실행 승인이 아니다.

1. `r2-upload-manifest.json`의 세 파일을 다시 해시하고 후보 목록과 대조한다. 웹 자산·공유 모듈·Worker 소스도 `candidate-manifest.json`과 대조한다. 기존 검증의 적용 범위와 6-1절 자료 보존 조건을 확인한다. 현재 PC에서 NSIS 설치 EXE를 실행하지 않기로 한 선택을 유지하며, 별도 계정/VM의 설치·등록·복원 QA는 `docs/release-checklist.md`의 기존 미완료 항목을 따른다.
2. `barorok-releases`의 정확한 세 키에 한정해 업로드한다. 기존 키가 있으면 전체 원격 파일의 크기·SHA가 동일한 경우만 재사용하며 다른 내용은 덮어쓰지 않는다. 400MB 이상 파일은 기존 8MiB 분할 업로드(multipart upload) 경로를 대상 세 파일에 맞춰 검토한 뒤 사용한다. 이전 버전 하나만 허용하는 임시 uploader를 그대로 실행하지 않는다. 단기 업로드 도구·자격 증명·전송 코드는 아직 생성하거나 실행하지 않았다. 일반 공개 다운로드 Worker에는 업로드 권한을 추가하지 않는다.
3. 원격 세 객체를 끝까지 다시 읽어 SHA·크기를 확인하고 `customMetadata.sha256`도 대조한다. 통과 전에는 descriptor를 공개하지 않는다. 실패하면 미완료 분할 전송만 정리하고 기존 객체·공개 버전은 유지한다. 기존 엔진·ZIP 객체는 삭제하지 않는다.
4. 기존 공개 버전과 자산·소스의 복원점을 확보하고, 후보 JSON을 정본에 반영한 변경을 검토·커밋한다. push는 별도 승인 범위를 따른다. 웹 자산이 후보와 같은 소스인지 확인한다. 데스크톱 빌드 commit은 실제 내장값을 유지하며 새 Worker 커밋으로 바꾸지 않는다.
5. 저장소가 정한 기존 배포 경로 `corepack pnpm --dir deploy/cloudflare run deploy`를 승인 범위에서 실행한다. 운영 릴리스 태그와 엔진 버전 태그는 릴리스 체크리스트 7절을 따른다. 배포 전 후보만 확인하는 명령은 아래와 같다. `check`는 `deploy --dry-run`이며 실제 배포하지 않는다.

   ```powershell
   corepack pnpm --dir deploy/cloudflare run check --config D:\Projects\LMO_audio\.tmp\publication-20261027\wrangler.jsonc --outdir D:\Projects\LMO_audio\.tmp\publication-20261027\worker-build
   ```

6. 실제 HTTPS의 세 feed·HEAD·부분 다운로드·전체 해시, 이전 엔진 링크, 현재 웹과 엔진의 연결, 데스크톱 업데이트 안내·기록 보존을 확인한다. 오류 시 승인된 복원점으로 웹을 롤백한다. 안내만 회수할 때는 해당 desktop descriptor를 `release:null`로 바꿔 승인된 경로로 배포하며 사용자 PC의 파일·자료는 건드리지 않는다. 단기 업로드 Worker를 썼다면 작업 후 제거·자격 증명 폐기를 확인한다.

검증 명령: `corepack pnpm --dir deploy/cloudflare test`, `corepack pnpm --dir deploy/cloudflare exec node wrangler.mjs types`, `corepack pnpm --dir desktop-app exec tsc --noEmit -p ../deploy/cloudflare/tsconfig.json`. Worker 타입 설정은 Node strip-types용 `.ts` import와 공유 브라우저 helper의 fetch 타입을 포함한다.

### 같은 날의 실제 공개 요청과 웹 다운로드 진입점

후속 요청으로 실제 R2 업로드·웹 배포·공개 후 시험이 승인됐다. 초기 준비 후보는 이력으로 보존하고, 웹 전용 다운로드 버튼을 포함한 새 후보는 `.tmp/publication-ui-20261027`로 구분한다. 패키지 세 파일의 내용·키·SHA는 초기 후보와 같고, 웹 자산과 관련 UI 소스의 해시만 새 후보에 반영한다. 데스크톱·엔진 바이너리는 검증한 clean `282d5d20` 빌드이며, 새 웹/Worker의 소스 commit과 구분한다.

웹의 새 회의록 제목줄 오른쪽 `데스크톱 앱 받기`는 안내창을 열고 공개 신규 설치 feed만 조회한다. 안내창의 `Windows용 ZIP 받기`를 눌러야 정확한 신규 설치 ZIP 주소를 연다. 웹 회의록의 자동 이전을 약속하지 않으며, 기존 설치 갱신은 업데이트 안내를 이용하도록 구분한다. 미공개·조회 실패·재확인·취소를 처리한다. 기본 화면·안내창·1032px 좁은 창 캡처와 Escape/초점 복귀·명시적 클릭 전 파일 요청 없음은 `.tmp/publication-run-20261027/download-ui-preview.json`과 PNG에 기록했다. 이 미리보기는 공개 전 feed만 fixture로 제공한 시각 검사이며, 운영 HTTPS 검증은 별도 무모의 실행으로 한다.

이번 업로드의 임시 도구는 `.tmp/publication-run-20261027/transfer`에 한정한다. 고정된 세 키·크기·SHA·4시간 만료·인증·자체 서명 세션을 검증하고, 8MiB 조각을 직렬 전송한 뒤 원격 전체 읽기 해시를 확인한다. 실패한 엔진 전송 복구 도구의 서명 키 불일치는 실제 handler.begin→cleanup 통합 모의 검사로 수정·독립 재검토했고 11검사를 통과했다. 동일 조각과 안전한 GET만 제한적으로 재시도하며 완료 요청의 불명확한 결과는 자동 재시도·삭제하지 않는다. 공개 웹 Worker에는 업로드 경로를 추가하지 않는다. 실제 업로드·배포 결과와 임시 도구 제거 여부는 릴리스 체크리스트의 실제 공개 절을 따른다.
