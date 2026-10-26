# 데스크톱 업데이트 공개 절차

데스크톱은 `release-manifest.json`의 `commit`과 `generatedAt`으로 빌드를 구분한다. `tauri.conf.json`의 `0.1.0`이나 웹 연결용 설치 엔진 버전으로 비교하지 않는다. 새 빌드는 기존 빌드보다 생성 시각이 늦고 커밋이 다를 때만 안내한다. 같은 커밋 재빌드는 업데이트로 안내하지 않는다. 개발 실행·dirty 빌드·빌드 정보가 없는 설치본은 자동 비교 대상에서 제외한다.

현재 `desktop-release.json`의 `release`는 `null`이다. 이는 **데스크톱 업데이트 패키지를 아직 공개하지 않았다**는 뜻이며 `/downloads/desktop-beta.json`은 404를 반환한다. 설치 엔진 EXE나 신규 설치 패키지로 대신 연결하지 않는다. 아래 준비와 별도 공개 승인을 마치기 전에는 값을 채우지 않는다.

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
