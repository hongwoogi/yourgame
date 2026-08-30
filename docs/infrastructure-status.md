# 인프라 연결 상태

확인일: 2026-08-31, Asia/Seoul. GitHub·Vercel·Turso·yourga.me 연결을 완료했다. Google 로그인·제안 접수·카운트다운 코드를 구현하고 운영 DB 스키마를 적용했으며, 새 코드의 운영 배포를 검증 중이다. 게임 공개와 자동 진화는 아직 시작하지 않았다.

## 제안 접수 구현과 검증

- Node.js 22 서버 API 6개와 정적 진입 화면을 구현했다. 최근 60분 최대 3개·UTF-8 2,000바이트·마감·수정·중복 재시도는 서버와 DB에서 검사한다.
- 운영 DB에 schema v1을 비파괴 적용했다. 사용자·세션·제안·세션 생성 제한용 테이블과 제약을 추가했으며 시험 사용자나 제안은 넣지 않았다.
- `npm run build`의 백엔드·서명 검증·모니터 테스트 45개와 Playwright 브라우저 흐름 13개가 통과했다. 독립 worker 3개에서 동시에 보낸 24개 접수 중 정확히 3개만 저장했다. 계정 전환·오래된 응답·일시적인 조회 실패의 화면 경합도 재현 후 수정했다.
- 로컬 실제 UI와 실제 Google 버튼 렌더링을 확인했다. Google 계정 로그인을 끝까지 완료한 검증은 아직 없으며, 테스트 대역 검사와 구분한다.
- Vercel Production에 `APP_ORIGIN=https://yourga.me`를 등록했다. 기존 Google·Turso 환경변수를 유지한다. 다른 origin에서의 변경 요청은 허용하지 않는다.
- 기존 `/health.json`의 고정 성공 파일을 없애고 DB·인증 설정을 확인하는 `/api/health`로 연결한다. Google 클라이언트 설정의 존재만으로 실제 로그인 정상 여부를 판정하지 않는다.
- 아래의 준비 페이지·초기 연결 기록은 이전 단계의 검증 이력이다. 신규 배포와 정기 점검의 실제 결과는 확인 뒤 이 절에 기록한다.
- 최초 구현 커밋 `a2af46f`의 배포는 테스트 보조 파일 `tests/backend-helpers.mjs`가 커밋에서 빠져 빌드에 실패했다. 실패를 보고하고 누락 파일을 추가했다. 재배포 전에는 Git 커밋만 추출한 별도 폴더에서 설치·빌드를 검사한다. 실패한 빌드를 접수 기능 공개 성공으로 기록하지 않는다.

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
