# 인프라 연결 상태

확인일: 2026-08-31, Asia/Seoul. 사용자가 CLI 등으로 각 서비스에 접근해 처리하도록 요청했다. 아래 작업은 인프라 연결이며 게임 공개나 제안 모집을 시작하지 않는다.

## 완료

- GitHub CLI 인증: hongwoogi. 비공개 저장소 [hongwoogi/yourgame](https://github.com/hongwoogi/yourgame)를 생성하고 로컬 main을 연결했다.
- Vercel CLI 인증: hso1025-2820. hso1025-2820s-projects 팀에 [yourgame 프로젝트](https://vercel.com/hso1025-2820s-projects/yourgame)를 생성하고 GitHub 저장소를 연결했다.
- main의 준비 페이지 커밋 b95b547573c021560d694b4ffca105b50f5bc79b에서 production 자동 배포 성공을 확인했다. 배포 ID는 dpl_29TNzkJsvuvxu4EUrVyAzbB5FAm7이며 GitHub 상태의 배포 링크와 일치했다.
- [기본 운영 주소](https://yourgame-eosin.vercel.app)의 /와 /health.json에서 HTTP 200을 확인했다. health는 stage=infrastructure, gamePublished=false, collectionOpen=false다.
- /docs/design.md와 /.env.local은 HTTP 404였다. Vercel은 public 디렉터리만 제공하고 설계 문서 및 로컬 인증 자료는 제외했다.
- yourga.me를 Vercel 프로젝트에 등록했다. 도메인 소유권 상태는 current-scope / verified이나 실제 DNS 구성은 아직 invalid-configuration이다. 도메인 소유 확인과 웹사이트 접속 가능 상태를 구분한다.
- Cloudflare 네임서버 hank.ns.cloudflare.com과 ivy.ns.cloudflare.com을 확인했다. 네임서버와 DNS 레코드는 변경하지 않았다.

## 남은 승인과 작업

### Turso

Vercel CLI에서 tursocloud/database의 Starter 플랜이 월 $0, ID starter로 표시되는 것을 확인했다. DB 이름 yourgame, region hnd1(도쿄), production 연결만 지정해 생성 요청을 했지만 integration_terms_acceptance_required 응답으로 중단되었다. 기존 직접 가입 Turso 계정과 Marketplace 연결의 관계는 아직 확인하지 않았다.

사용자가 [Turso Marketplace 약관 승인](https://vercel.com/hso1025-2820s-projects/~/integrations/accept-terms/tursocloud?source=cli)을 완료한 뒤 다음 요청을 재개한다. 재시도 전 installation과 resource 목록을 확인해 중복 생성을 피한다.

```powershell
npx --yes vercel@59.10.0 integration add tursocloud/database --name yourgame --plan starter --metadata region=hnd1 --environment production --no-env-pull --json --scope hso1025-2820s-projects
```

그다음 실제 플랜·한도, DB 생성, production 환경변수 연결 및 DB 연결 테스트를 확인한다. DB 토큰을 대화, GitHub 또는 public 파일에 출력하지 않는다. 유료 플랜·초과 사용 플랜·추가 크레딧 구매는 하지 않는다.

### Cloudflare / yourga.me

Vercel CLI가 발급한 [Cloudflare Domain Connect 승인 화면](https://vercel.com/api/v9/projects/prj_mX7sSyD4MNHC1lc17e07QDDb8SrY/domains/yourga.me/domain-connect/apply?teamId=team_5ZRqZzRDBFzkQ7Jtek9O3bH7)을 통해 이 도메인의 DNS 변경을 검토·승인한다. 이 경로를 이용하면 별도 Cloudflare API 토큰을 대화에 전달할 필요가 없다.

현재 verify 응답은 충돌 레코드 없음, 루트 CNAME @ → d67c31e03d9e2a52.vercel-dns-017.com., proxy 비활성화를 권장한다. 이는 해당 프로젝트에서 조회한 값이며 다른 프로젝트에 일반화하지 않는다. 실제 반영 직전에 새 권장값과 기존 레코드를 다시 확인하고 메일·다른 서비스 레코드는 변경하지 않는다. Cloudflare 네임서버는 유지한다.

```powershell
npx --yes vercel@59.10.0 domains verify yourga.me --scope hso1025-2820s-projects
```

승인 후 DNS, HTTPS, /와 /health.json 응답을 확인한다. 현재는 yourga.me 연결 완료라고 안내하지 않는다.

## 로컬 도구와 인증 보호

- GitHub CLI 2.76.2, Node 22.17.0을 확인했다. Vercel 59.10.0과 Wrangler 4.127.1은 npx로 실행할 수 있다. Wrangler는 인증되지 않았고 DNS 편집 권한도 부여하지 않았다.
- Turso 공식 CLI v1.0.32 Linux 배포 파일을 내려받고 공식 checksums.txt와 SHA-256을 대조했다. 기존 Docker 환경에 yourgame-turso-cli:1.0.32 이미지를 구성해 실행을 확인했다. 새 WSL 배포판이나 DB 서버를 설치한 것이 아니다. CLI 인증은 아직 하지 않았다.
- Turso 로컬 자료는 .local 아래에 보관한다. Vercel CLI의 프로젝트 연결 파일은 .vercel, 자동으로 받은 로컬 OIDC 자료는 .env.local에 있으며 모두 Git에서 제외되는 것을 확인했다.
- 브라우저 연결 도구는 실행 단계에서 경로 오류가 반복되어 이번 작업에서 로그인·동의 화면을 조작하지 못했다. 서비스의 사용자 승인 단계를 우회하지 않는다.
- Codex 모델 실행, 정기 작업, 게임 버전 집계 및 제안 수집은 시작하지 않았다.
