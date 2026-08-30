# 무료 관리형 DB 비교

상태: 공식 문서 조사 후 Turso 무료 플랜을 선택했다. 이후 사용자가 회원가입 완료를 알리고 CLI 연결을 요청했다. 2026-08-31 GitHub·Vercel 연결을 완료했고, Turso DB 생성은 Marketplace 약관 승인 대기 중이다. DB 생성이나 유료 플랜 선택은 수행하지 않았다.

## 요구와 추천

사용자는 GitHub와 Vercel을 유지하고 직접 DB 서버를 운영하지 않기를 원한다. 기존 Supabase는 프로젝트 한도가 찼으므로 후보에서 제외한다. 게임 세이브는 로컬에 두고 온라인 DB에는 계정, 제안, 집계, 기여 이력, 최소 활동 기록과 작업 상태를 저장한다.

비교 당시 추천은 **Turso Free**, 대안은 **Neon Free**였으며 이후 사용자가 GitHub·Vercel·Turso Free 구성을 수락했다. 실제 Vercel CLI의 tursocloud/database 연동에서는 무료 플랜이 Starter, plan ID starter, 월 $0로 표시되는 것을 확인했다. 도쿄 hnd1, 이름 yourgame, production 연결을 지정한 생성 요청은 약관 승인 요구로 중단되어 아직 DB를 생성하지 않았다. 기존 직접 가입 Turso 계정과 Marketplace 계정의 관계 및 실제 사용량 한도는 연결 후 확인한다.

## 공식 무료 한도 비교

| 후보 | 확인한 무료 한도 | 이 설계에서의 판단 |
| --- | --- | --- |
| Turso Free | 저장 5GB, 월 행 읽기 5억, 행 쓰기 1천만. 카드 없이 시작 가능. | 작업 상태와 활동 기록을 다루는 작은 실험에 우선 검토할 만하다. 인덱스와 집계가 필요하며 무료 지속 운영은 실제 부하에 달려 있다. |
| Neon Free | 프로젝트당 저장 0.5GB, 월 100 CU-hours, 공용 전송 5GB. 카드 없이 시작 가능. | 관리형 Postgres와 Vercel 연동이 장점이다. 잦은 DB 조회가 유휴 중지를 막으면 적은 데이터로도 compute 한도를 소진할 수 있다. |

출처: [Turso 요금](https://turso.tech/pricing?frequency=monthly), [Neon 요금](https://neon.com/pricing).

두 서비스 모두 Vercel native 연동을 제공한다. 다만 공식 Marketplace와 직접 가입 요금표의 설명·한도가 일치한다고 가정하지 않는다. 특히 Turso의 Marketplace에는 직접 요금표와 다른 DB 개수 및 가격 안내가 있어 실제 연결 화면의 Free 플랜과 초과 사용 설정을 확인해야 한다. [Turso 연동](https://vercel.com/marketplace/tursocloud/database), [Neon 연동](https://vercel.com/marketplace/neon)

## Turso를 우선 추천하는 이유 — 설계 판단

- 현재 요구에는 Postgres 전용 기능이 명시되어 있지 않다. 제안과 작업 상태처럼 작은 구조화 데이터가 주 대상이다.
- 무료 사용량이 DB를 켜 둔 시간이 아니라 저장·읽기·쓰기를 중심으로 명시되어 있어 작업 상태 조회의 영향을 추산하기 쉽다.
- Turso의 행 읽기는 반환 행 수와 같지 않고 스캔한 행 수도 영향을 준다. 무료 한도가 커 보이더라도 적절한 인덱스와 제한된 조회 범위가 필요하다. 한도 초과 쿼리는 BLOCKED 오류로 실패할 수 있으므로 쓰기 성공을 확인하지 않은 제안을 저장 완료로 안내해서는 안 된다. [사용량과 한도](https://docs.turso.tech/help/usage-and-billing)
- 설치·패치 등 DB 서버 운영을 사용자가 맡지 않는 구조다. 스키마, 접근 권한, 보관 정책과 사용량 확인은 여전히 애플리케이션 운영의 일부다.
- 사용자 로그인은 DB 접근 토큰과 별개다. DB의 연결 기능만으로 참여자 로그인이 구현되었다고 보지 않으며, 실제 로그인 방식은 별도 설계한다.

## 무료 운영에서 주의할 사항

### Neon을 선택할 경우

Free compute는 5분 유휴 후 중지되며 새 연결과 반복 작업이 이를 방해할 수 있다. 최소 0.25 CU로 30일 내내 실행되면 0.25 × 24 × 30 = 180 CU-hours이므로 월 100 CU-hours를 넘는다. 매분 작업 큐를 조회하거나 상태 신호를 DB에 기록하는 설계는 피해야 한다. 무료 한도 초과 시 compute가 중지될 수 있으므로, 저장량이 작다는 이유만으로 무료 운영을 보장하지 않는다. [유휴 중지](https://neon.com/docs/introduction/scale-to-zero), [연결 관리](https://neon.com/docs/manage/endpoints/), [요금](https://neon.com/pricing)

### 정해진 시간의 실행

Vercel Hobby cron은 작업당 하루 한 번으로 제한되며 지정 시각의 해당 시간대 안에서 실행될 수 있어 3시간 간격의 정시 작업을 맡기지 않는다. 사용자는 Vercel Cron 없이 개인 PC에서 처리를 수행하고 GitHub에 올려 Vercel Git 연동 배포를 유발하는 방식을 선택했다. PC 측의 시각 관리 방식은 로컬 작업자로 구현하며 플랫폼 예약 기능을 사용하지 않는다. [Vercel cron 제한](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Windows Task Scheduler](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-start-page)

GitHub Actions의 schedule도 혼잡 시 지연·누락될 수 있으므로 정확한 정시 실행을 보장하는 대안으로 취급하지 않는다. [GitHub schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

### 호스팅과 보관

- 무료 DB 선택이 웹 호스팅, 인증, 파일 보관과 AI 실행까지 무제한 무료라는 뜻은 아니다.
- Vercel Hobby의 개인·비상업적 사용 조건과 사용량 한도를 따라야 한다. 광고·결제·상업적 운영을 추가하면 다시 검토한다. [Hobby 안내](https://vercel.com/docs/plans/hobby)
- DB에는 게임 빌드와 이미지·사운드를 넣지 않는다. GitHub는 코드·버전 이력과 빌드 보관에 활용하고, 실제 아카이브의 실행 파일 제공 방식은 별도 검증한다.
- 매초 활동 이벤트를 무제한 누적하지 않고 필요한 확인 기록과 회차·세션별 집계를 중심으로 저장하는 것을 권장한다. 집계가 활동 검증을 대체한다는 뜻은 아니다.
- 한도 도달 시 자동 유료 업그레이드를 전제하지 않는다. 기존 정적 게임 제공과 제안 접수·로그인·통계 등 DB 의존 기능의 상태를 구분해 안내하도록 설계한다.

## 추천 역할 분담

| 구성 요소 | 역할 |
| --- | --- |
| GitHub | 코드, 변경 이력, 공개 버전 관리 |
| Vercel | PC용 게임 사이트, 제안 API, 운영 대시보드 제공 |
| Turso Free — 선택됨 | 계정·제안·집계·기여 이력·작업 상태 보관 |
| 개인 PC의 Codex | 주기별 요구 처리, 코드 변경 후보 생성과 검증 |
| 플레이어 브라우저 | 버전별 게임 세이브 보관 |
