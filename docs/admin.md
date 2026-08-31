# 관리자 기능과 접근 제어

상태: 2026-08-31 요청에 따른 구현 기준. 구현·검증·배포 결과는 작업 기록에서 별도로 확인한다. 함께 승인된 PC 게임 옆 제안창과 모바일 지원·9:16 게임 방향은 [플레이·제안 화면 기준](play-and-propose.md)에 기록한다.

## 관리자와 접근

- 관리자는 `hso1025@gmail.com` 한 계정이다. Google 서명·발급자·audience·만료·nonce를 검증한 ID 토큰에서 `email_verified=true`와 정확한 이메일을 확인한다. 대소문자만 통일하며 Gmail 점·별칭·`+` 주소를 추가 관리자로 확장하지 않는다.
- 최초로 확인된 관리자 Google 계정 ID(sub)를 서버에 고정한다. 브라우저가 보낸 이메일·이름·권한·로컬 저장소로 관리자를 지정하지 않는다. 일반 회원에게 관리자 승격 기능을 제공하지 않는다.
- `/master` HTML과 `/api/admin`의 모든 조회·변경을 서버에서 검사한다. 비로그인은 로그인으로 안내하고 일반 회원은 거부한다. 모든 관리자 응답은 캐시하지 않는다. 관리자 자격 증명이나 데이터는 공개 HTML에 넣지 않는다.
- 변경에는 CSRF·Origin 검사, 요청 식별자, 최신 revision, 사유와 감사 기록이 필요하다. 서비스 종료·종료 후 재개는 최근 15분 이내 Google 로그인과 확인 문구를 추가로 요구한다. 관리자는 자신을 이용 정지할 수 없다.
- 관리자 화면도 영어 기본·한국 접속 시 한국어·수동 언어 선택을 제공한다. 종료 확인은 정확한 `END SERVICE`, 재개 확인은 `RESUME SERVICE`로 언어와 무관하게 고정한다. 서버는 기존 `서비스 종료`, `서비스 재개`도 해당 작업에만 호환 허용한다. 언어 전환은 사유·체크박스·확인 입력·미확정 요청을 바꾸거나 재전송하지 않는다. [언어 지원 기준](localization.md)을 따른다.

서버 토큰 검증과 변경되지 않는 Google `sub`를 계정 식별에 사용하는 근거는 [Google ID 토큰 서버 검증 안내](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)를 따른다. 실제 운영자 로그인 검증은 Google 운영 origin 허용 설정이 정상인 환경에서 별도로 수행한다.

## 관리 범위

| 영역 | 제공하는 동작 | 보존·제한 |
| --- | --- | --- |
| 회원 | 목록·검색·제안 수 조회, 이용 정지·해제 | 계정·기여 이력 삭제 없음. 정지하면 세션을 회수하고 새 접수를 서버에서 차단 |
| 프롬프트 | 회원·회차·운영 검토·안전 상태별 조회, 개발 대상 제외·복원, 별도 내용 안전 심사 | 원문·접수 시각·제출 횟수 보존. 관리자가 원문을 대신 고치거나 삭제하지 않음 |
| 개발 버전 | 개발 요청과 진행 이력, 대기 요청 취소, 실행 중 중단 요청, 실패 작업 재시도 요청 | 실제 게임 공개 이력과 앱 커밋을 혼동하지 않음. 요청 등록이 자동 개발·검증·공개 완료를 뜻하지 않음 |
| 서비스 운영 | 접수·자동 개발 허용, 점검 상태, 공지, 종료와 재개, 감사 이력 | 데이터·프로젝트·도메인 삭제나 결제 변경 없음. 종료 중에도 관리자 복구 접근 유지 |

2026-09-01 복구 구현에는 신뢰된 운영자 전용 게임 검토 영수증과 공개 선택·확인·복귀 저장소를 추가했다. 웹 관리자 action을 늘리거나 생성 역할에 해당 권한을 주지 않는다. 후보 검증은 진행 중이며 실제 공개 성공은 DB 선택·배포 바이트·운영 플레이 확인 증거로 별도 판단한다. 확인된 정상 게임이 없으면 복귀 대상을 만들어내지 않고 준비 화면을 유지한다.

## 운영 상태

- `active`: 활성 상태. 신규·수정 접수와 자동 개발은 각 허용 스위치를 추가로 검사한다.
- `maintenance`: 점검 상태. 신규·수정 접수와 새 개발·공개는 멈춘다. 보존된 데이터 조회와 로그인·관리자 접근은 유지한다.
- `ended`: 종료 안내를 제공하고 신규·수정 접수와 자동 개발·공개를 멈춘다. 두 허용 스위치를 함께 끈다. 종료는 데이터 삭제가 아니다. 재개할 때 관리자가 다시 허용할 기능을 선택한다.

의도적인 점검·종료를 서비스 장애로 판단하여 자동 재개하지 않는다. 종료 중 자동 점검은 관측만 계속하며 새 제작·배포·복귀를 실행하지 않는다. 실행 중 작업은 다음 안전 확인 지점에서 중단하고, 결과 공개 직전에도 현재 상태와 중단 요청을 확인한다. 외부에 이미 전송한 배포 요청을 이 설정이 즉시 취소한다고 표시하지 않는다.

관리에서 제외한 프롬프트와 이용 정지 회원의 프롬프트는 개발 입력에서 제외한다. 여기에 현재 본문·정책의 명시적 안전 승인과 개발용 정리문이 있어야 한다. 기존 운영 `reviewed`만으로는 안전 승인이 아니다. 고정한 회차 스냅샷은 임의로 덮어쓰지 않는다. 이후 관리 상태가 바뀌어 기존 입력이 부적합해지면 해당 스냅샷 사용을 멈추고 재확인한다.

## Teen 안전 심사

[참여 안전 기준](participation-safety.md)에 따라 `pending|approved|held|blocked`를 운영 검토와 별도로 관리한다. 신규 접수와 성공한 수정은 안전 검토 대기로 들어간다. 단순 규칙 검사는 의미 심사를 대신하지 않으며 기존 제안도 자동 승인하지 않는다.

관리자는 원문을 텍스트로 확인하고 Teen 표현 상한, 개인정보·괴롭힘 등 참여 안전, 운영 명령·권한 요청 여부를 점검한다. 승인에는 점검 확인·사유·게임 변경만 담은 개발용 정리문이 필요하다. 정리문은 UTF-8 2,000바이트 이내이며 원문을 덮어쓰지 않는다. 명백히 금지된 현재 본문을 강제 승인하는 기능은 제공하지 않는다.

웹의 안전 변경은 `review_proposal_safety` 동작으로만 처리한다. 공통 요청 식별자·사유와 함께 제안 ID, 현재 `proposalRevision`, `bodyHash`, `policyVersion`, 안전 상태의 `revision`을 보낸다. 승인에는 `checklistConfirmed=true`와 `developmentBrief`가 필요하다. 서버가 현재 본문과 해시를 다시 확인하고 한 트랜잭션에서 승인·감사를 기록한다. 브라우저 값만으로 승인 대상을 정하지 않는다. 명시적으로 위임된 로컬 운영자 심사는 아래 별도 경로를 따른다.

수정·다른 심사와 충돌하면 원문을 다시 읽고 점검해야 한다. 이전 체크박스를 유지한 채 바뀐 내용에 승인을 재전송하지 않는다. 불확실한 전송 결과는 같은 요청 ID로 확인하며 새 ID로 중복 실행하지 않는다. 일반 회원에게는 상태와 고정된 안내만 보여주고 내부 사유·탐지 원문을 공개하지 않는다.

안전 승인은 개발 입력 사용에 대한 판단이다. 실제 게임·자산·전투 연출·실행 격리 검증이나 공식 ESRB 등급 취득을 대신하지 않으며 투표·기여도 지급을 바로 발생시키지 않는다.

## 위임받은 로컬 운영자 안전 심사

2026-08-31 사용자는 Codex에 개별 안전 심사·승인을 위임하고 운영 DB로 처리하도록 명시했다. 이 범위에서 신뢰된 운영자는 `scripts/operator-safety-review.mjs`를 사용한다. 웹 관리자 세션을 만들거나 Google 사용자로 사칭하지 않는다. 웹 API·관리자 권한 검사는 그대로 유지한다.

먼저 `admin-worker.mjs status --round initial`로 운영 상태를 확인한다. `node --env-file=.env.production.local scripts/operator-safety-review.mjs export .local/<review-run>/intake.json initial`은 현재 본문과 정확한 심사 연결을 비공개 파일에만 내보낸다. 운영자가 각 원문을 실제로 읽고 Teen·개인정보·운영 지시·정리문을 심사한 뒤 `apply .local/<review-run>/decision.json`으로 기록한다. 금칙어 미검출은 승인 근거가 아니며, 모호한 게임 요구는 `held`로 남길 수 있다. `pending`인 정확한 버전만 변경하고 이미 결정된 심사는 자동 덮어쓰지 않는다.

쓰기 트랜잭션 안에서 운영 revision·개발 허용·정책·현재 원문 해시·심사 ID/revision·회원 정지·제외를 확인한다. `operator_review_proposal_safety` 감사 행에 위임 참조·검토자·사유·정확한 결정 digest를 남긴다. `actor_user_id`와 `reviewer_id`는 NULL이며 `actor_name=codex-delegated:<operatorId>`로 실제 행위자를 구분한다. 같은 요청 ID의 정확한 재실행은 감사 영수증으로 확인하며 다른 결정은 거절한다. 전송 결과가 불명확하면 DB부터 재조회한다.

이 도구는 기존 운영 DB 자격증명을 가진 신뢰된 운영자 전용이며 웹에 노출하거나 생성 역할에 전달하지 않는다. JSON의 위임 참조 자체는 권한 증명이 아니다. 이 입력 심사 도구는 산출물 검토·실행 격리나 공개 승인을 대신하지 않는다. 현재의 JSON 출력 전용 제작 경로와 아래 별도 산출물 영수증 경로에서도 입력 승인만으로 공개할 수 없으며 기여도 발급은 계속 별도 차단한다. 심사 전후 원문·계정·세션·공개 설정·투표·점수·운영 제어 보존 증거는 `.local/<review-run>/`에 기록한다.

## 신뢰된 산출물 검토와 공개 선택

게임 모델은 검증된 도구 없는 실행에서 승인 정리문·필요한 선행 JSON만 처리하고, 닫힌 데이터 응답만 반환한다. 부모가 현재 input-gate와 정확한 바이트를 결합하며 모델 출력의 명령·JS·HTML·URL·자가 승인값은 실행하거나 공개 권한으로 쓰지 않는다. 실제 경계와 단계별 산출물은 [게임 에이전트 계약](game-agent-workflow.md)을 따른다.

기존 운영 권한을 가진 신뢰된 운영자는 실제 Teen·EN/KO 의미 검토와 해당 후보의 런타임·브라우저 시험을 마친 뒤 `createGameReleaseStore(client).issueReview(...)`를 호출한다. 저장소는 테스트를 대신 실행하거나 boolean의 진실을 판정하지 않는다. `game_release_reviews`는 후보·run·정책·snapshot/source/assets digest·게임 버전·내용/runtime/실행 증거 digest, 현재 작업자·run/service revision·round·정확한 입력 binding을 불변 기록과 운영자 감사에 연결한다. 같은 요청 ID의 다른 내용은 충돌이며 정확한 재실행은 이미 발급된 기록만 반환한다. 기록의 존재와 현재 입력 적합성은 별도로 확인한다.

준비는 `admin-worker status` 확인 뒤 `prepareGameReleaseSchema(client,{expectedServiceRevision})`, `preparePublicationSchema(client,{expectedServiceRevision})`를 명시적으로 실행한다. 기존 DB·계정·제안·투표·원장·저장은 바꾸지 않는 추가 스키마다. 일반 초기화·HTTP 조회가 자동 준비하거나 발급하지 않는다.

`createGamePublicationStore(client)`의 운영자 전용 순서는 `getSelection`으로 최신 revision 확인 → `activate`로 정확한 검토 후보 잠정 선택 → 운영 배포의 바이트·실제 플레이 확인 → observation digest를 포함한 `confirm` → 작업자의 `completed` 기록이다. `confirm`은 같은 검토에 묶인 작업이 아직 running이고 현재 운영·입력 조건이 맞을 때만 성공한다. 잠정 선택은 실제 정상본 검증과 다르다. 공개 응답은 DB 선택과 신뢰된 배포 목록의 version/hash/review가 일치할 때만 version·sha256과 선택적 이전 정상본 정보만 반환하며 비공개 영수증·입력은 내보내지 않는다.

후보 실패 시 최신 revision의 `rollback`으로 이전 **확인된** 정상 게임 또는 null 선택에 복귀하고 실제 제공 상태를 재확인한다. 잠정 후보를 복귀 정상본으로 승격하지 않는다. selected/verified/rollback 이벤트와 감사는 불변이며, 정확한 operationId 재실행은 기존 결과를 반환한다. 중지·변경된 서비스를 자동 재개하지 않고 계정·본문 이력·점수·세이브를 초기화하지 않는다. 실제 운영 공개 기록은 이 문서나 앱 배포 성공으로 대신하지 않는다.

## 서버·화면 연결 계약

관리자 화면의 기준 주소는 `/master`이며 `/master/`도 같은 보호된 `/api/admin-page`로 연결한다. 기존 `/admin`, `/admin/` 북마크는 GET 요청에 한해 쿼리를 보존하여 같은 출처의 `/master`로 307 이동한다. 이 이동은 DB·세션·관리자 HTML을 읽지 않으며, 도착한 `/master`에서 기존 권한 검사를 수행한다. 두 주소와 리디렉트는 모두 `no-store`; GET 외 요청은 405로 거절한다. 내부 API 이름과 권한 모델은 바꾸지 않는다.

관리자 화면 HTML은 계속 `server/admin-page.html`, 공개 정적 자산은 `/admin.js`, `/admin.css`를 사용한다. 자산 파일 자체에는 관리자 데이터·키·운영자 이메일을 넣지 않는다.

관리자 화면도 모바일에서 접근할 수 있게 한다. 좁은 화면에서는 목록과 상세를 세로로 배치하며, 종료 같은 중요한 동작의 확인 문구·사유·결과를 가리지 않는다. 모바일이라는 이유로 서버의 권한 검사를 완화하지 않는다.

`/api/session`의 로그인 사용자에 서버가 판정한 `isAdmin`을 제공한다. 비로그인은 `null`, 일반 회원은 참이 아닌 값이다. 관리자 링크는 이 값에 따라 표시하되 실제 접근 권한은 서버가 다시 검사한다. `/?master=1`은 관리자 로그인 이동, `/?master=1&reauth=1`은 민감 작업의 재로그인 경로로만 사용하며 이동 대상은 `/master`로 고정한다. 이 로그인은 제안 전송 의도가 아니다.

과거 `/?admin=1` 로그인 링크도 호환하며, 완료·취소 시 `master`·`admin`·`reauth` 매개변수를 모두 소비하여 재진입을 막고 로그인 성공 뒤에는 `/master`로만 이동한다.

관리 API 조회는 `GET /api/admin?section=overview|users|proposals|versions|audit`다. 페이지 크기는 최대 50개로 제한하며 커서 기반 조회를 사용한다. 검색은 `q`, 운영 상태는 `status`, 안전 상태는 `safetyStatus`, 프롬프트 회차는 `round`, 회원은 `userId`로 필터한다.

- overview: `{ admin: { id, name, email, recentAuthUntil }, service, counts, recentAudit }`
- users: `{ items: [{ id, name, email, createdAt, updatedAt, status, isAdmin, proposalCount, revision }], nextCursor }`
- proposals: `{ items: [{ id, user: { id, name, email }, body, roundId, createdAt, revision, moderation, moderationRevision, moderationReason, safety }], nextCursor }`
- proposal safety(관리자만): `{ status, revision, proposalRevision, bodyHash, policyVersion, reviewId, reason, developmentBrief, developmentBriefHash, checklistConfirmed, reviewedAt, hardBlocked }`. 본인용 제안 API에는 고정 안내와 `status`만 제공하며 내부 이유·정리문·검토자의 정보를 공개하지 않는다.
- versions: `{ items: [{ id, label, status, summary, createdAt, updatedAt, revision, parentId, cancelRequested, commitSha }], nextCursor }`
- audit: `{ items: [{ id, createdAt, action, targetId, reason, actorName }], nextCursor }`
- service: `{ mode, proposalsEnabled, developmentEnabled, message, revision, updatedAt }`
- counts: `{ users, suspendedUsers, proposals, excludedProposals, versions, pendingVersions }`

모든 변경은 `POST /api/admin`이며 공통으로 `{ action, requestId, reason }`을 받는다. 성공 시 `{ ok: true }`와 필요한 결과를 반환하고 화면은 해당 목록을 다시 조회한다. 같은 요청 식별자의 다른 본문은 충돌로 거부한다.

- `set_user_status`: `userId`, `status=active|suspended`, `revision`
- `moderate_proposal`: `proposalId`, `moderation=pending|reviewed|excluded`, `revision`(moderationRevision)
- `review_proposal_safety`: `proposalId`, 안전 `status`, 안전 `revision`, `proposalRevision`, `bodyHash`, `policyVersion`, 승인 시 `checklistConfirmed`, `developmentBrief`
- `create_version`: `label`, `summary`
- `retry_version`: `versionId`, `revision` — 실패·취소 기록을 유지하고 새 대기 요청을 생성
- `cancel_version`: `versionId`, `revision` — 대기 요청은 취소, 실행 중 요청에는 중단 요청 표시
- `set_service`: `mode`, `proposalsEnabled`, `developmentEnabled`, `message`, `revision`, 필요 시 `confirmation=END SERVICE|RESUME SERVICE`(각 작업의 기존 한국어 문구도 호환 허용)

개발 요청 상태는 `queued|running|failed|completed|cancelled`다. `completed`는 작업 완료 기록이며, 그 값만으로 게임 공개 여부가 바뀌지 않는다. 관리자 API로 실행·검증 성공 상태를 직접 입력하지 않는다. 작업자 기록과 검증된 게임 공개는 별도 절차다.

`/api/status`는 안전한 공개 운영 상태 `service: { mode, proposalsEnabled, developmentEnabled, message }`를 함께 반환한다. 접수 불가 시 `collection.status=paused|ended`로 표시한다. public health는 의도적인 운영 중지를 인프라 장애로 표시하지 않는다. 서버 저장 단계에서도 현재 상태와 회원 정지를 같은 트랜잭션 안에서 다시 검사한다.

## 데이터 이전과 작업자 연결

기존 schema_version=1의 계정·제안 테이블은 보존하고 관리자용 테이블·별도 마이그레이션 버전을 추가한다. 안전 확장도 별도 `safety_meta`와 심사·원문 revision·요청 빈도 기록으로 적용하며 기본·관리자 스키마 버전을 되감지 않는다. `initializeDatabase`는 이 확장까지 적용한다. 먼저 추가 스키마를 적용해도 기존 운영 배포의 상태 검사가 실패하지 않게 한다. 운영 DB에 테스트 계정·프롬프트·종료 상태를 만들지 않는다.

로컬 작업자는 DB 권한이 있는 기존 환경에서 운영 상태·개발 요청을 읽는다. 시작·스냅샷 사용·결과 기록·배포 직전에 서비스 허용 상태와 작업 중단 요청을 검사한다. 관리자 원문·프롬프트·토큰을 로그나 공개 상태에 출력하지 않는다. 조회 실패 시 개발·배포는 중단하며, 제어 값을 모른 채 활성으로 가정하지 않는다.

## 로컬 작업자 명령

모든 명령은 `node --env-file=.env.production.local scripts/admin-worker.mjs` 뒤에 아래 인자를 붙인다. 운영 상태를 바꾸거나 관리자 계정을 만드는 명령은 제공하지 않는다. `.env` 값은 런타임에서 읽으며 출력하지 않는다.

| 인자 | 동작 |
| --- | --- |
| `status` | 현재 운영 상태 확인. 중지 상태를 활성으로 변경하지 않음 |
| `status --round initial` | 최초 회차의 안전 심사 집계도 확인. 다음 회차 대기는 `--round pending`; 스냅샷과 혼용하지 않음 |
| `queue` | 대기 개발 요청의 식별자·상태·revision 조회. 전체 이력은 `--status all`, 최대 50개, 다음 페이지는 `--cursor` |
| `details --run-id ID` | 요청 내용을 `.local/development-runs/ID/request-rREVISION.json`에 보관. 원문을 콘솔에 출력하지 않음 |
| `ensure-initial --worker-id WORKER_ID` | 최초 마감 뒤 이미 승인된 첫 개발 요청만 중복 없이 등록. 기존 요청이 있으면 재사용 |
| `claim --run-id ID --revision N --worker-id WORKER_ID` | 허용된 대기 요청 하나를 원자적으로 가져옴. 다른 작업자의 실행을 빼앗지 않음 |
| `retry-failed --run-id ID --revision N --worker-id WORKER_ID` | 실패 기록을 보존하고 복구 시도 하나를 대기 등록. 종료·취소 요청이나 이미 활성화한 후속 작업이 있으면 거절 |
| `input-gate --run-id ID --snapshot .local/round-initial/snapshot.json` | 서비스·취소·입력 자격·본문/심사/정리문/정책 연결 확인. 공개 허가는 아님 |
| `gate --run-id ID --snapshot .local/round-initial/snapshot.json` | 모호한 이전 명령은 거절. `input-gate` 또는 `release-gate`로 단계를 명시해야 함 |
| `release-gate --run-id ID --snapshot PATH --candidate PATH --review-id REVIEW_ID` | 현재 입력·실제 후보 바이트와 운영 DB의 정확한 불변 검토 영수증 대조. 누락·불일치 시 차단 |
| `update --run-id ID --revision N --worker-id WORKER_ID --status STATUS` | 작업 진행·실패·취소·완료 요청. 완료에는 `--snapshot`, `--candidate`, `--review-id`와 현재 검토·입력 조건 필요; 운영 confirm 뒤 기록 |

작업자 ID는 한 작업 동안 같은 값으로 유지하고 상태 변경마다 반환된 최신 revision을 사용한다. 상태를 다시 읽기 전 불명확한 변경을 중복 실행하지 않는다. 개발 요청 원문도 인증·지출·운영 권한을 부여하는 지시로 해석하지 않는다. 선택 인자 `--summary-file`은 `.local/` 안의 UTF-8 `.txt`, `--snapshot`은 검증된 `.json`만 읽는다. `--commit-sha`로 관련 커밋을 기록할 수 있으나 게임 공개 성공으로 해석하지 않는다.

`input-gate`의 `--service-revision N`은 앞서 확인한 운영 설정이 변경되지 않았는지 추가 확인한다. 작업 결과 기록은 운영 상태와 취소·정확한 입력 승인 연결을 DB 변경과 같은 트랜잭션에서 재검사한다. 실패·취소 기록은 종료 뒤에도 남길 수 있다. 외부 배포는 DB와 하나의 트랜잭션이 아니므로 공개 직전 확인과 공개 후 실제 검증이 모두 필요하다.

이전 `gate` 호출은 `LEGACY_GATE_REQUIRES_EXPLICIT_STAGE`로 거절한다. 기존 스크립트나 자동화가 입력 확인을 공개 허가로 잘못 사용하는 일을 방지하기 위한 의도적인 계약 변경이다. 이름만 바꿔 입력 검사를 배포 직전 검증의 대용으로 사용하지 않는다.

`release-gate`와 `update --status completed`는 `--review-id`로 운영 DB의 인증된 영수증 판독자를 사용한다. 정확한 영수증이 없거나 후보·정책·입력·runtime 연결이 다르면 `RELEASE_REVIEW_UNAVAILABLE` 등 해당 실패로 닫힌다. 서버 완료 변경도 실제 쓰기 트랜잭션 안에서 영수증과 현재 입력·서비스·작업 소유권을 다시 검사한다. 입력 승인이나 자가 검사·화면 캡처·파일 해시 비교만으로 검토를 대신하지 않는다.

`node scripts/check-game-release.mjs --snapshot PATH --run-id ID --candidate .local/game-candidates/CANDIDATE_ID/candidate.json` 단독 CLI는 정확한 후보 파일 목록·소스/자산 digest를 읽기 전용으로 검사한다. 인증된 DB 영수증 판독자를 전달하지 않으므로 이 단독 실행은 여전히 `RELEASE_REVIEW_UNAVAILABLE`이고, 스스로 작성한 승인 JSON이나 옵션으로 허가를 만들 수 없다. 어느 gate 명령도 스스로 게임을 배포·선택·확인하지 않는다. 신뢰된 서비스 코드의 보안 수정 배포 역시 게임 공개 성공과 구분한다.

종료 코드 0은 해당 범위의 명령 완료, 2는 의도적인 중지·마감/안전 검토 대기·게임 공개 선행조건 미충족, 1은 조회·입력·기록 오류다. 0인 입력 확인을 공개 승인으로 해석하거나 2를 해결하려 안전 기준·운영 제어를 끄지 않는다. 1에서는 개발·배포를 진행하지 않고 원인을 확인한다. 제안 원문은 비공개 서버 이력에 두고 회차 스냅샷 v2에는 승인된 게임 요구 정리문과 원문·심사·정책 연결만 보관한다. 개발 요청 원문은 `details`의 비공개 기록에만 보관하며 콘솔에는 내보내지 않는다. 고정 스냅샷은 16 MiB까지 검증하며 제한 초과나 내용 충돌 때 임의로 잘라 사용하지 않는다. 심사 정보가 없는 v1 스냅샷은 재사용하지 않는다. 입력이 0개일 때 실제 제안 없음과 안전 검토 대기를 구분하여 알리고 빈 입력으로 게임을 만들거나 완료 기록을 남기지 않는다.

이미 승인된 장애 복구에는 `retry-failed`를 사용할 수 있으나 서비스 종료·개발 중지·관리자의 취소를 무시하여 재개하지 않는다. 실패했던 원본의 상태를 성공으로 덮어쓰지 않고 새 요청을 연결한다. 자동 재시도는 후속 요청이 하나도 없는 마지막 실패 기록에서만 가능하다. `queue --status all`의 parentId를 따라 최신 시도를 확인하며, 완료·취소된 후속 시도가 있는데 실패했던 원본으로 돌아가 다시 시작하지 않는다. 비공개 쓰기 경로는 실제 파일시스템 경계를 검사하여 junction·symlink가 공개 자산 폴더나 외부 경로를 가리키면 중지한다.
