# 인프라 연결 상태

확인일: 2026-08-31, Asia/Seoul. Google 로그인·제안 접수·카운트다운 코드와 운영 DB 스키마를 배포했다. 운영 화면·DB·익명 세션·보안 거부 응답은 정상이다. 초기 Google origin 403은 03:26 KST의 실제 버튼 재검사에서 재현되지 않았다. 버튼 정상 표시와 실제 계정의 로그인·접수·관리자 접근 완료는 구분하며 게임은 아직 공개하지 않았다.

## 국기 언어 선택·모바일 상단바·관리자 주소 변경

- 2026-08-31 요청에 따라 닫힌 언어 선택창은 영어에 미국 국기, 한국어에 태극기를 표시한다. 로컬 SVG와 기존 네이티브 선택창을 사용하며 펼친 언어 이름·키보드·접근성 이름·44px 터치 영역·선호 저장을 유지한다. 공개 화면과 관리자 화면, 열린 모달에 같은 표시를 적용한다.
- 모바일 상단바는 로고·국기·계정 조작을 한 줄로 배치한다. 좁은 화면에서는 계정 조작을 아이콘으로 표시하고 긴 사용자 이름은 시각적으로 숨긴다. 서버에서 관리자라고 확인한 사용자에게만 관리 화면 링크가 보인다.
- 기준 관리자 주소를 `/master`로 바꾸고 `/master/`도 기존 서버 권한 검사를 거치게 한다. 과거 `/admin`·`/admin/`의 GET은 쿼리를 보존해 같은 출처 `/master`로 307 이동하고 다른 메서드는 405로 거절한다. 모든 보호 화면·리디렉트는 캐시하지 않는다. `/api/admin`과 `/api/admin-page`, Google 권한·CSRF·민감 작업 재인증은 유지한다.
- 새 로그인 진입 `/?master=1`과 과거 `/?admin=1`을 함께 지원한다. 진입 플래그는 소비하며 관리자 로그인은 제안을 자동 전송하지 않는다. 로그인 후 이동 대상은 `/master`로 고정하고 임의 외부 이동 지시는 받지 않는다.
- 라우팅 점검 중 기존 `/api/community`·`/api/locale`의 5xx가 감시 허용 목록에서 빠져 무시되는 것을 확인했다. 실제 장애 발생을 뜻하지는 않으며, 두 고정 경로와 새 관리자 경로를 감시 목록에 추가한다. 임의 경로·쿼리값·원문 로그는 계속 기록하지 않는다.
- 서버·코어 검사 227개와 Playwright 104개가 통과했다. 별도 화면 검사에서 익명·회원·관리자 메인과 관리자 화면의 영어·한국어 및 320·360·390·1440px 32조합을 확인했고 상단바 겹침·가로 넘침은 없었다. 열린 언어 목록의 읽기와 키보드 선택·저장도 확인했다. 로그인 UI와 인증된 관리자 검사는 모의 계정이며 실제 운영 계정 인증을 대신하지 않는다.
- DB 스키마·계정·제안·공개 동의·투표·기여도 발행 정책을 변경하지 않는다. 전체 검사, Git 커밋에서만 꺼낸 설치·빌드, 배포 커밋 일치, 실제 화면·권한 거부·데이터 보존 확인은 비공개 `.local/master-header-release-verification.json`에 남긴다. 실제 Google 버튼 표시와 실제 계정 인증 완료는 별개다.

## 로그인 준비 순서 후속 수정

- 2026-08-31 07:46 KST 로컬에서 세션이 초기 공개 설정보다 먼저 도착하면 잘못된 Google 설정 오류가 남는 문제를 재현했다. 설정 응답이 나중에 성공해도 버튼이 준비되지 않았다. Google 설정이 아직 없으면 조회를 기다리도록 수정했으며, 기존 설정이 있는 경우 불필요한 재조회를 강제하지 않아 관리자 재인증 경로를 유지한다.
- 재시도 도중 창을 닫고 다시 열면 오래된 조회가 새 Google 버튼과 인증 콜백을 무효화하는 문제도 로컬에서 재현했다. 조회를 시작한 창과 현재 창이 같은지, 창이 열려 있는지, 이미 인증 중인지 확인하고 오래된 처리를 중단한다. 초기 설정 대기에도 같은 창 확인을 적용하며 언어 전환·초안·명시적 전송 원칙은 유지한다.
- 새 회귀 3개는 지연된 설정, 창 재열기, 오래된 재시도 뒤 콜백 유효성을 Google/API 모의 환경에서 검사한다. 기존 관리자 상태 조회 장애 복구 검사와 함께 확인한다. 전체 검사·커밋 단독 설치와 빌드·배포·실제 제공자 검증은 비공개 `.local/login-readiness-recovery-verification.json`에 남긴다. 보조 검사의 관측 미완료, 재현된 화면 문제, 실제 계정 인증 미검증을 별도로 기록하며 공개 상태 HTTP 200만으로 복구를 선언하지 않는다.

## 공개 의견·투표·기여도 후속 작업

- 메인에 흰 9:16 캔버스, 최근/인기 의견 각 6개와 기여도 상위 10명을 연결했다. PC는 미리보기 옆 제안창, 모바일은 아래 제안창이며 영어 기본·한국어 선택을 유지한다. 캔버스는 플레이 가능한 게임이 아니다.
- 별도 생성 별칭과 본문 revision별 공개 동의, 현재 안전 승인·회원 상태를 적용한다. 최초 모집 마감까지 회차당 찬반 합산 활성 3표, 방향 전환·취소·멱등 요청·동시성 검사를 제공한다. 리더보드 공개는 별도 동의다. 기존 비공개 제안을 일괄 노출하지 않는다.
- 서버·코어 223개와 Playwright 100개, 합계 323개 검사가 통과했다. 네이티브 DB 연결 3개에서 12개 동시 투표 중 정확히 3개만 성공했다. 교차검토에서 계정 불일치 후 개인정보 잔류, 다음 회차 미정 DTO, 429·깨진 성공 응답 후 재확인 요청 보존 문제를 찾아 배포 전에 수정하고 회귀로 확인했다. UI의 로그인 검사는 Google/API 대역이며 실계정 인증과 다르다.
- 첫 커뮤니티 커밋 `56f422ed4041`의 별도 Git archive 검사에서 기존 모니터 타임아웃 테스트 1개가 빠른 `network_error`로 실패해 배포를 보류했다. 이 PC의 임시 포트 범위에 Fetch 차단 포트가 포함되어 같은 실패가 발생할 수 있음을 재현했다. 최초 로그에는 포트가 없어 특정 포트가 당시 원인이라고 단정하지 않는다. 테스트 서버는 49152~65535 범위에서 충돌·권한 오류를 최대 16회 재시도하도록 수정했다. 실제 네트워크 오류와 타임아웃 구분은 유지했고 관련 검사 18개를 5회 연속 통과했다. 운영 포트 설정이나 모니터 판정은 바꾸지 않았다.
- 독립 로컬 서버와 빈 개발 DB에서 영어·한국어 각각 1440·390·320px의 흰 캔버스 픽셀·9:16 비율·배치·가로 넘침을 확인했다. 스크립트 오류와 제안 변경 요청은 없었고 가짜 참여자·제안·점수를 넣지 않았다.
- 06:14 KST 운영 DB에 커뮤니티·기여도 테이블을 추가했다. 운영 허용 확인과 변경을 같은 write 트랜잭션으로 묶었다. 기존 base/admin/safety 버전은 1로 유지했으며 적용 전후 기존 운영 배포의 health는 200이었다. 회원 5명과 제안 3개의 식별자·원문·보존 이력, 검토 대기 3건·승인 0건, 운영 revision=1이 유지됐다. 공개 프로필·공개 동의·표·점수는 모두 0건이다.
- 제안자 배점의 `**`가 제곱인지 표당 가중치인지 확인 중이며 공개 정책은 미확정으로 둔다. 실제 게임 공개·충족 증거 발급자가 없어 점수 발행도 차단한다. 기존 100/50·20%·300점 상한 추천은 적용하지 않는다. [투표·기여도 기준](voting-and-contribution.md)과 [API 계약](community-api.md)을 따른다.
- 배포 커밋만 꺼낸 설치·빌드와 실제 운영 도메인·해당 커밋의 일치, 운영 UI·Google 버튼·데이터 보존 최종 확인은 비공개 `.local/community-release-verification.json`에 별도로 남긴다. 웹사이트 배포 성공을 게임 공개나 기여도 지급 성공으로 기록하지 않는다.

## 영어·한국어 후속 작업

- 2026-08-31 영어 기본 UI, 한국 접속 자동 한국어, 우측 상단 수동 선택·저장, 모달 내 선택을 구현했다. 소개·공유 메타·Google 버튼·제안·안전 안내·오류·보호된 관리자 화면을 함께 번역했다. 자세한 우선순위와 번역하지 않는 원문은 [언어 지원 기준](localization.md)을 따른다.
- 국가 판별에는 신뢰된 Vercel 배포의 국가 헤더만 사용한다. `/api/locale`은 DB·세션 생성 없이 동작하고 국가 조회 실패 시 영어를 유지한다. 실제 신규 로컬 프로세스에서도 이 경로와 언어 헤더·쿠키 우선순위를 확인했다.
- 서버·브라우저 코어 검사 162개와 Playwright UI 검사 83개가 통과했다. 늦은 다른 탭 알림이 새 수동 선택을 덮는 문제를 배포 전에 재현·수정했다. 영문 320·360·390·1440px, 언어 전환 중 로그인·초안·수정·안전 심사·동일 요청 재시도를 검증했다.
- 언어 작업에는 DB 스키마 변경이나 데이터 이전이 없다. 운영 데이터에 시험 회원·제안·심사·종료 상태를 넣지 않는다. 배포된 정확한 커밋·운영 국가 추천·실제 Google 버튼·원문 보존 검증은 비공개 `.local/` 기록으로 남기고, 모의 Google 검사와 실계정 인증을 구분한다.

## 관리자·모바일 후속 작업

- 지정 Google 운영자만 접근하는 관리자 HTML/API, 회원 정지·복원, 제안 검토·제외·복원, 개발 요청·취소·재시도, 서비스 점검·종료·재개를 추가한다. 원문과 실패 이력은 보존한다. 범위는 [관리자 기준](admin.md)을 따른다.
- PC 전용 화면 차단을 제거하고 320·360·390px부터 현재 제안 화면의 배치를 확인했다. 공개 후에는 PC 게임 옆 제안창, 모바일 게임 아래 제안창과 9:16 게임 영역을 적용한다. 실제 게임 구현·공개 기록은 아니다.
- 03:24 KST 운영 DB에 관리자용 추가 스키마를 적용했다. 기본 schema_version=1과 기존 회원·제안 수가 유지됐고 적용 전후 기존 운영 배포의 health는 200이었다. 테스트 계정·제안·종료 상태는 넣지 않았다.
- 03:26 KST 새 익명 Chromium에서 운영 Google 버튼 HTTP 200과 origin 오류 미발생을 확인했다. Google 콘솔 설정은 변경하지 않았으며 실제 계정 인증을 완료하지 않았다.
- 개별 배포의 커밋·실제 도메인 확인 결과는 비공개 `.local/` 작업 검증 기록으로 남긴다. 기능 테스트와 UI의 Google/API 대역 검사, 실제 제공자 버튼 검사, 실계정 인증 여부를 구분한다.

## 제안 접수 구현과 검증

- Node.js 22 서버 API 6개와 정적 진입 화면을 구현했다. 최근 60분 최대 3개·UTF-8 2,000바이트·마감·수정·중복 재시도는 서버와 DB에서 검사한다.
- 운영 DB에 schema v1을 비파괴 적용했다. 사용자·세션·제안·세션 생성 제한용 테이블과 제약을 추가했으며 시험 사용자나 제안은 넣지 않았다.
- 백엔드·서명 검증·상태 모니터 테스트 45개, 추가된 API 오류 로그 모니터 테스트 12개, Playwright 브라우저 흐름 13개가 통과했다. 독립 worker 3개에서 동시에 보낸 24개 접수 중 정확히 3개만 저장했다. 계정 전환·오래된 응답·일시적인 조회 실패의 화면 경합도 재현 후 수정했다.
- 로컬과 운영의 실제 UI를 확인했다. 운영 Google 버튼은 HTTP 403 및 origin 미허용 오류를 반환했다. Google 계정 로그인을 끝까지 완료한 검증은 아직 없으며, 테스트 대역 검사와 구분한다.
- Vercel Production에 `APP_ORIGIN=https://yourga.me`를 등록했다. 기존 Google·Turso 환경변수를 유지한다. 다른 origin에서의 변경 요청은 허용하지 않는다.
- 기존 `/health.json`의 고정 성공 파일을 없애고 DB·인증 설정을 확인하는 `/api/health`로 연결한다. Google 클라이언트 설정의 존재만으로 실제 로그인 정상 여부를 판정하지 않는다.
- 아래의 준비 페이지·초기 연결 기록은 이전 단계의 검증 이력이다.
- 최초 구현 커밋 `a2af46f`의 배포는 테스트 보조 파일 `tests/backend-helpers.mjs`가 커밋에서 빠져 빌드에 실패했다. 실패를 보고하고 누락 파일을 추가했다. 재배포 전에는 Git 커밋만 추출한 별도 폴더에서 설치·빌드를 검사한다. 실패한 빌드를 접수 기능 공개 성공으로 기록하지 않는다.
- 수정 커밋 `a68b11143d52`를 Git archive로 추출한 별도 폴더에서 `npm ci`·`npm run build`로 검사해 45개를 통과했다. 이후 GitHub Vercel success와 배포 `dpl_12N8PEPfMPxy76QFxCX3K4HBuBq5`의 READY를 확인했다. API 6개는 Node.js 22, hnd1, 최대 30초로 배포됐다.
- 실제 `https://yourga.me`에서 화면, 보안 헤더, `/api/health`, `/health.json`, 공개 시각·제한값, 익명 세션의 보안 쿠키, 비로그인·다른 origin·잘못된 CSRF·잘못된 Google 자격증명·DELETE 거부를 확인했다. 시험 사용자·제안은 운영 DB에 만들지 않았다.
- 공개 별칭의 `/`가 코드의 `/:path*` 조건에 매칭되지 않는 것을 발견했다. CLI의 실제 변환으로 루트·마지막 슬래시 경로 누락을 재현해 `/:path(.*)`로 보완했다. 별도로 공개 도메인 `yourgame-eosin.vercel.app`에만 대상 `yourga.me`, 상태 308의 공식 도메인 리다이렉트를 설정했고 `/`, `/api/status`, 마지막 슬래시 경로의 실제 308을 확인했다. 내부 배포 별칭의 Vercel SSO 302는 그대로 유지했다. [도메인 설정 API](https://vercel.com/docs/rest-api/projects/update-a-project-domain)

## 등록한 후속 점검

- 자동화 ID `yourga-me`, 이름 `yourga.me 장애 점검과 첫 공개`, 현재 작업에 연결된 heartbeat다. 처음에는 5분 간격으로 등록했으나 이번 안전 점검에서 실제 로컬 설정은 60분 간격 ACTIVE임을 확인했다. 안전 지시를 추가할 때 현재 주기·대상 작업·알림 설정은 보존한다.
- 최초 등록 뒤 수동으로 동일한 상태 점검과 API 오류 로그 점검을 실행했다. 화면·DB 상태 정상, 최근 10분 API 5xx 관측 0건, 상태 기록 저장 정상을 확인했다. 당시 Google의 외부 origin 403은 별도 미해결 상태로 남겼으며 최신 제공자 상태는 위 후속 작업 기록을 따른다.
- `.local/monitor-state.json`, `.local/incidents.jsonl`, `.local/runtime-monitor-state.json`, `.local/google-provider-status.json`으로 확인 상태와 알려진 차단을 구분한다. 원문 제안·로그·자격증명은 모니터 출력에 넣지 않는다.
- 최초 마감 후의 확정 입력·제작·검증·공개 후속 절차도 같은 자동화에 연결했다. 이는 최초 게임 제작·공개 성공을 미리 기록한 것이 아니다. PC와 Codex 앱이 실행 중이어야 하며 사용량·네트워크·앱 상태에 따라 감지와 후속 실행이 지연될 수 있다.

## GitHub와 Vercel

- GitHub CLI 계정은 hongwoogi다. [hongwoogi/yourgame](https://github.com/hongwoogi/yourgame) 비공개 저장소를 생성하고 로컬 main을 연결했다.
- Vercel CLI 계정은 hso1025-2820, 팀은 hso1025-2820s-projects다. [yourgame 프로젝트](https://vercel.com/hso1025-2820s-projects/yourgame)를 만들고 GitHub main과 연결했다.
- 준비 페이지 커밋 b95b547573c021560d694b4ffca105b50f5bc79b의 production 배포 dpl_29TNzkJsvuvxu4EUrVyAzbB5FAm7에서 최초 성공을 확인했다. 후속 문서 커밋 a4a4544199804e1c4237c10b4c33936e05c115be에서도 GitHub Vercel 상태가 success였다.
- [기본 운영 주소](https://yourgame-eosin.vercel.app)와 [대표 도메인](https://yourga.me)에서 준비 페이지를 제공한다. 이는 게임 v1 공개나 최초 모집 시작이 아니다.

## Turso DB

- 사용자가 Marketplace 약관을 승인한 뒤 기존 리소스가 없는지 확인하고 DB를 생성했다.
- 표시 이름: yourgame. Vercel resource ID: store_wLiuR6ULq4MNuyle. Installation ID: icfg_VrculnAgBQYulUrXg4304Rak.
- 연동: tursocloud/database. 지정한 지역: hnd1(도쿄). 플랜: Starter, ID starter, 월 $0. 생성 후 inspect에서 Starter 플랜과 available 상태를 확인했다. 유료 플랜이나 초과 사용 플랜은 선택하지 않았다.
- 프로젝트 yourgame의 production 환경에 TURSO_DATABASE_URL과 TURSO_AUTH_TOKEN이 연결되어 있다. preview와 development에는 운영 DB를 연결하지 않았다.
- production 환경변수를 Git에서 제외한 .env.production.local로 받아 로컬에서 SELECT 1 AS connected를 실행했고 결과 1을 확인했다. 테이블·게임 데이터·스키마는 만들거나 변경하지 않았다. 공식 [SQL over HTTP](https://docs.turso.tech/sdk/http/reference)의 execute/close 요청을 사용했다.
- 이 검증은 실제 DB 인증·연결 및 Vercel 환경변수 설정을 확인한 것이다. 아직 존재하지 않는 게임 서버 API의 동작을 검증한 것은 아니다.
- 기존 직접 가입 Turso 계정과 Marketplace 조직의 관계 및 세부 사용량 한도는 별도 확인 사항이다. 직접 가입 Free 요금표의 수치를 이 Marketplace DB에 그대로 적용하지 않는다.

리소스를 다시 확인할 때는 이름으로 조회한다. 이번 CLI에서는 resource ID로 inspect하면 찾지 못했고, integration 필터를 사용한 list도 빈 결과를 반환했다. 전체 리소스 목록, 이름 기반 inspect 및 실제 DB 쿼리를 함께 확인했다.

```powershell
npx --yes vercel@59.10.0 integration list --all --json --scope hso1025-2820s-projects
npx --yes vercel@59.10.0 integration resource inspect yourgame --json --scope hso1025-2820s-projects
```

## yourga.me DNS와 HTTPS

- 사용자 연결 승인 후 Vercel verify가 configured-correctly, ok=true를 반환했다. 소유권과 프로젝트 연결도 verified다.
- Cloudflare 네임서버 ivy.ns.cloudflare.com과 hank.ns.cloudflare.com은 유지됐다. 네임서버 이전이나 별도 Wrangler DNS 편집은 수행하지 않았다.
- 승인 후 실제 A 응답은 64.29.17.65와 216.198.79.65였고 Vercel은 정상 구성으로 판정했다. 이전 안내의 추천 주소와 다르다는 이유로 정상 레코드를 다시 수정하지 않았다.
- https://yourga.me/ 및 /health.json의 HTTP 200을 확인했다. 기본 TLS 검증을 비활성화하지 않았다. health는 stage=infrastructure, gamePublished=false, collectionOpen=false다.
- Vercel은 public 디렉터리만 웹에 제공한다. 설계 문서와 환경변수 파일은 배포 업로드에서 제외한다.

```powershell
npx --yes vercel@59.10.0 domains verify yourga.me --scope hso1025-2820s-projects
```

## 로컬 도구와 인증 보호

- GitHub CLI 2.76.2, Node 22.17.0, Vercel CLI 59.10.0, Wrangler 4.127.1을 확인했다. Wrangler는 인증하지 않았으며 이번 DNS 연결은 사용자가 승인한 Domain Connect 경로를 사용했다.
- Turso 공식 CLI v1.0.32는 공식 SHA-256과 대조한 Linux 실행 파일로 Docker 이미지 yourgame-turso-cli:1.0.32를 구성해 실행을 확인했다. 직접 CLI 로그인은 사용하지 않았으며 실제 DB 관리는 Vercel Marketplace 경로로 처리했다. PC에 DB 서버나 새 WSL 배포판을 설치한 것이 아니다.
- .vercel, .local, .env.local, .env.production.local은 Git에서 제외한다. DB 토큰은 대화나 public 파일에 출력하지 않는다.
- Vercel 연동 CLI가 자동 설치한 .agents/skills/turso-cloud와 skills-lock.json은 로컬 도구 자료로 유지하고 Git·배포 업로드에서 제외한다.
- 브라우저 연결 도구 오류로 처음 동의 화면을 조작하지 못했으며, 사용자가 필요한 승인을 마친 뒤 CLI 작업을 재개했다. 승인 우회나 별도 Cloudflare API 토큰 발급은 하지 않았다.
- Codex 모델 실행, 정기 작업, 게임 버전 집계, 데이터 스키마 및 제안 수집은 아직 시작하지 않았다.

## Google 로그인 준비

- 2026-08-31 사용자가 제공한 웹용 OAuth 2.0 클라이언트의 ID와 비밀키를 `.env.local`과 Vercel Production의 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`으로 등록했다. Production의 두 변수는 Secret 유형이며 Preview·Development 원격 환경은 변경하지 않았다.
- 로컬 값의 원본 일치, Production 변수 존재와 Secret 유형, Git 제외와 추적 가능 파일의 실제 값 미포함을 확인했다. 값 자체는 문서나 도구 출력에 기록하지 않는다.
- 브라우저 연결 도구 오류로 Google 콘솔의 허용 origin을 확인하지 못했다. 제공 파일에 주소 목록이 없다는 사실만으로 콘솔 설정도 비어 있다고 단정하지 않는다.
- 로그인 UI와 서버 세션은 이후 구현해 자동 검사를 통과했다. 실제 Google 계정 로그인과 허용 origin 검증은 별도로 남아 있다. 자세한 범위와 남은 검증은 [Google 로그인 준비 상태](google-login-setup.md)를 따른다.
