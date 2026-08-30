# 인프라 연결 상태

확인일: 2026-08-31, Asia/Seoul. GitHub·Vercel·Turso·yourga.me 연결을 완료했다. 인프라 확인용 준비 페이지를 제공하며 게임 공개, 제안 모집 및 자동 진화는 아직 시작하지 않았다.

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
