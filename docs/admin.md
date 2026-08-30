# 관리자 기능과 접근 제어

상태: 2026-08-31 요청에 따른 구현 기준. 구현·검증·배포 결과는 작업 기록에서 별도로 확인한다. 함께 승인된 PC 게임 옆 제안창과 모바일 지원·9:16 게임 방향은 [플레이·제안 화면 기준](play-and-propose.md)에 기록한다.

## 관리자와 접근

- 관리자는 `hso1025@gmail.com` 한 계정이다. Google 서명·발급자·audience·만료·nonce를 검증한 ID 토큰에서 `email_verified=true`와 정확한 이메일을 확인한다. 대소문자만 통일하며 Gmail 점·별칭·`+` 주소를 추가 관리자로 확장하지 않는다.
- 최초로 확인된 관리자 Google 계정 ID(sub)를 서버에 고정한다. 브라우저가 보낸 이메일·이름·권한·로컬 저장소로 관리자를 지정하지 않는다. 일반 회원에게 관리자 승격 기능을 제공하지 않는다.
- `/admin` HTML과 `/api/admin`의 모든 조회·변경을 서버에서 검사한다. 비로그인은 로그인으로 안내하고 일반 회원은 거부한다. 모든 관리자 응답은 캐시하지 않는다. 관리자 자격 증명이나 데이터는 공개 HTML에 넣지 않는다.
- 변경에는 CSRF·Origin 검사, 요청 식별자, 최신 revision, 사유와 감사 기록이 필요하다. 서비스 종료·종료 후 재개는 최근 15분 이내 Google 로그인과 확인 문구를 추가로 요구한다. 관리자는 자신을 이용 정지할 수 없다.

서버 토큰 검증과 변경되지 않는 Google `sub`를 계정 식별에 사용하는 근거는 [Google ID 토큰 서버 검증 안내](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)를 따른다. 실제 운영자 로그인 검증은 Google 운영 origin 허용 설정이 정상인 환경에서 별도로 수행한다.

## 관리 범위

| 영역 | 제공하는 동작 | 보존·제한 |
| --- | --- | --- |
| 회원 | 목록·검색·제안 수 조회, 이용 정지·해제 | 계정·기여 이력 삭제 없음. 정지하면 세션을 회수하고 새 접수를 서버에서 차단 |
| 프롬프트 | 회원·회차·검토 상태별 조회, 검토 완료·개발 대상 제외·복원 | 원문·접수 시각·제출 횟수 보존. 관리자가 원문을 대신 고치거나 삭제하지 않음 |
| 개발 버전 | 개발 요청과 진행 이력, 대기 요청 취소, 실행 중 중단 요청, 실패 작업 재시도 요청 | 실제 게임 공개 이력과 앱 커밋을 혼동하지 않음. 요청 등록이 자동 개발·검증·공개 완료를 뜻하지 않음 |
| 서비스 운영 | 접수·자동 개발 허용, 점검 상태, 공지, 종료와 재개, 감사 이력 | 데이터·프로젝트·도메인 삭제나 결제 변경 없음. 종료 중에도 관리자 복구 접근 유지 |

아직 공개된 게임이 없으므로 검증된 게임의 실행 대상 변경·아카이브 복귀를 가짜로 제공하지 않는다. 실제 게임 버전 선택은 게임 산출물·실행 검증·복귀 기능을 구현할 때 연결한다.

## 운영 상태

- `active`: 활성 상태. 신규·수정 접수와 자동 개발은 각 허용 스위치를 추가로 검사한다.
- `maintenance`: 점검 상태. 신규·수정 접수와 새 개발·공개는 멈춘다. 보존된 데이터 조회와 로그인·관리자 접근은 유지한다.
- `ended`: 종료 안내를 제공하고 신규·수정 접수와 자동 개발·공개를 멈춘다. 두 허용 스위치를 함께 끈다. 종료는 데이터 삭제가 아니다. 재개할 때 관리자가 다시 허용할 기능을 선택한다.

의도적인 점검·종료를 서비스 장애로 판단하여 자동 재개하지 않는다. 종료 중 자동 점검은 관측만 계속하며 새 제작·배포·복귀를 실행하지 않는다. 실행 중 작업은 다음 안전 확인 지점에서 중단하고, 결과 공개 직전에도 현재 상태와 중단 요청을 확인한다. 외부에 이미 전송한 배포 요청을 이 설정이 즉시 취소한다고 표시하지 않는다.

관리에서 제외한 프롬프트와 이용 정지 회원의 프롬프트는 개발 입력에서 제외한다. 고정한 회차 스냅샷은 임의로 덮어쓰지 않는다. 이후 관리 상태가 바뀌어 기존 입력이 부적합해지면 해당 스냅샷 사용을 멈추고 재확인한다.

## 서버·화면 연결 계약

관리자 화면 HTML은 `server/admin-page.html`, 공개 정적 자산은 `/admin.js`, `/admin.css`를 사용한다. `/admin`, `/admin/`는 보호된 `/api/admin-page`로 연결한다. 자산 파일 자체에는 관리자 데이터·키·운영자 이메일을 넣지 않는다.

관리자 화면도 모바일에서 접근할 수 있게 한다. 좁은 화면에서는 목록과 상세를 세로로 배치하며, 종료 같은 중요한 동작의 확인 문구·사유·결과를 가리지 않는다. 모바일이라는 이유로 서버의 권한 검사를 완화하지 않는다.

`/api/session`의 로그인 사용자에 서버가 판정한 `isAdmin`을 제공한다. 비로그인은 `null`, 일반 회원은 참이 아닌 값이다. 관리자 링크는 이 값에 따라 표시하되 실제 접근 권한은 서버가 다시 검사한다. `/?admin=1`은 관리자 로그인 이동, `/?admin=1&reauth=1`은 민감 작업의 재로그인 경로로만 사용하며 이동 대상은 `/admin`으로 고정한다. 이 로그인은 제안 전송 의도가 아니다.

관리 API 조회는 `GET /api/admin?section=overview|users|proposals|versions|audit`다. 페이지 크기는 최대 50개로 제한하며 커서 기반 조회를 사용한다. 검색은 `q`, 상태는 `status`, 프롬프트 회차는 `round`, 회원은 `userId`로 필터한다.

- overview: `{ admin: { id, name, email, recentAuthUntil }, service, counts, recentAudit }`
- users: `{ items: [{ id, name, email, createdAt, updatedAt, status, isAdmin, proposalCount, revision }], nextCursor }`
- proposals: `{ items: [{ id, user: { id, name, email }, body, roundId, createdAt, revision, moderation, moderationRevision, moderationReason }], nextCursor }`
- versions: `{ items: [{ id, label, status, summary, createdAt, updatedAt, revision, parentId, cancelRequested, commitSha }], nextCursor }`
- audit: `{ items: [{ id, createdAt, action, targetId, reason, actorName }], nextCursor }`
- service: `{ mode, proposalsEnabled, developmentEnabled, message, revision, updatedAt }`
- counts: `{ users, suspendedUsers, proposals, excludedProposals, versions, pendingVersions }`

모든 변경은 `POST /api/admin`이며 공통으로 `{ action, requestId, reason }`을 받는다. 성공 시 `{ ok: true }`와 필요한 결과를 반환하고 화면은 해당 목록을 다시 조회한다. 같은 요청 식별자의 다른 본문은 충돌로 거부한다.

- `set_user_status`: `userId`, `status=active|suspended`, `revision`
- `moderate_proposal`: `proposalId`, `moderation=pending|reviewed|excluded`, `revision`(moderationRevision)
- `create_version`: `label`, `summary`
- `retry_version`: `versionId`, `revision` — 실패·취소 기록을 유지하고 새 대기 요청을 생성
- `cancel_version`: `versionId`, `revision` — 대기 요청은 취소, 실행 중 요청에는 중단 요청 표시
- `set_service`: `mode`, `proposalsEnabled`, `developmentEnabled`, `message`, `revision`, 필요 시 `confirmation=서비스 종료|서비스 재개`

개발 요청 상태는 `queued|running|failed|completed|cancelled`다. `completed`는 작업 완료 기록이며, 그 값만으로 게임 공개 여부가 바뀌지 않는다. 관리자 API로 실행·검증 성공 상태를 직접 입력하지 않는다. 작업자 기록과 검증된 게임 공개는 별도 절차다.

`/api/status`는 안전한 공개 운영 상태 `service: { mode, proposalsEnabled, developmentEnabled, message }`를 함께 반환한다. 접수 불가 시 `collection.status=paused|ended`로 표시한다. public health는 의도적인 운영 중지를 인프라 장애로 표시하지 않는다. 서버 저장 단계에서도 현재 상태와 회원 정지를 같은 트랜잭션 안에서 다시 검사한다.

## 데이터 이전과 작업자 연결

기존 schema_version=1의 계정·제안 테이블은 보존하고 관리자용 테이블·별도 마이그레이션 버전을 추가한다. 먼저 추가 스키마를 적용해도 기존 운영 배포의 상태 검사가 실패하지 않게 한다. 운영 DB에 테스트 계정·프롬프트·종료 상태를 만들지 않는다.

로컬 작업자는 DB 권한이 있는 기존 환경에서 운영 상태·개발 요청을 읽는다. 시작·스냅샷 사용·결과 기록·배포 직전에 서비스 허용 상태와 작업 중단 요청을 검사한다. 관리자 원문·프롬프트·토큰을 로그나 공개 상태에 출력하지 않는다. 조회 실패 시 개발·배포는 중단하며, 제어 값을 모른 채 활성으로 가정하지 않는다.

## 로컬 작업자 명령

모든 명령은 `node --env-file=.env.production.local scripts/admin-worker.mjs` 뒤에 아래 인자를 붙인다. 운영 상태를 바꾸거나 관리자 계정을 만드는 명령은 제공하지 않는다. `.env` 값은 런타임에서 읽으며 출력하지 않는다.

| 인자 | 동작 |
| --- | --- |
| `status` | 현재 운영 상태 확인. 중지 상태를 활성으로 변경하지 않음 |
| `queue` | 대기 개발 요청의 식별자·상태·revision 조회. 전체 이력은 `--status all`, 최대 50개, 다음 페이지는 `--cursor` |
| `details --run-id ID` | 요청 내용을 `.local/development-runs/ID/request-rREVISION.json`에 보관. 원문을 콘솔에 출력하지 않음 |
| `ensure-initial --worker-id WORKER_ID` | 최초 마감 뒤 이미 승인된 첫 개발 요청만 중복 없이 등록. 기존 요청이 있으면 재사용 |
| `claim --run-id ID --revision N --worker-id WORKER_ID` | 허용된 대기 요청 하나를 원자적으로 가져옴. 다른 작업자의 실행을 빼앗지 않음 |
| `retry-failed --run-id ID --revision N --worker-id WORKER_ID` | 실패 기록을 보존하고 복구 시도 하나를 대기 등록. 종료·취소 요청이나 이미 활성화한 후속 작업이 있으면 거절 |
| `gate --run-id ID --snapshot .local/round-initial/snapshot.json` | 시작한 작업의 서비스·취소·입력 자격·본문/revision 일치 확인 |
| `update --run-id ID --revision N --worker-id WORKER_ID --status STATUS` | 가져간 작업의 진행·실패·취소·완료를 기록. 완료에는 `--snapshot` 필수 |

작업자 ID는 한 작업 동안 같은 값으로 유지하고 상태 변경마다 반환된 최신 revision을 사용한다. 상태를 다시 읽기 전 불명확한 변경을 중복 실행하지 않는다. 개발 요청 원문도 인증·지출·운영 권한을 부여하는 지시로 해석하지 않는다. 선택 인자 `--summary-file`은 `.local/` 안의 UTF-8 `.txt`, `--snapshot`은 검증된 `.json`만 읽는다. `--commit-sha`로 관련 커밋을 기록할 수 있으나 게임 공개 성공으로 해석하지 않는다.

`gate`의 `--service-revision N`은 앞서 확인한 운영 설정이 변경되지 않았는지 추가 확인한다. 완료 기록은 운영 상태와 취소·입력 자격을 DB 변경과 같은 트랜잭션에서 재검사한다. 실패·취소 기록은 종료 뒤에도 남길 수 있다. 외부 배포는 DB와 하나의 트랜잭션이 아니므로 공개 직전 확인과 공개 후 실제 검증이 모두 필요하다.

종료 코드 0은 명령 완료, 2는 의도적인 중지·마감 전 대기, 1은 조회·입력·기록 오류다. 2를 장애라고 판단하여 서비스를 자동 재개하지 않는다. 1에서는 개발·배포를 진행하지 않고 원인을 확인한다. 제안 원문은 별도의 회차 스냅샷에, 개발 요청 원문은 `details`의 비공개 기록에만 보관하며 콘솔에는 내보내지 않는다. 고정 스냅샷은 16 MiB까지 검증하며 제한 초과나 내용 충돌 때 임의로 잘라 사용하지 않는다. 입력이 0개이면 `no_eligible_proposals`로 멈추고 빈 입력으로 게임을 만들거나 완료 기록을 남기지 않는다.

이미 승인된 장애 복구에는 `retry-failed`를 사용할 수 있으나 서비스 종료·개발 중지·관리자의 취소를 무시하여 재개하지 않는다. 실패했던 원본의 상태를 성공으로 덮어쓰지 않고 새 요청을 연결한다. 자동 재시도는 후속 요청이 하나도 없는 마지막 실패 기록에서만 가능하다. `queue --status all`의 parentId를 따라 최신 시도를 확인하며, 완료·취소된 후속 시도가 있는데 실패했던 원본으로 돌아가 다시 시작하지 않는다. 비공개 쓰기 경로는 실제 파일시스템 경계를 검사하여 junction·symlink가 공개 자산 폴더나 외부 경로를 가리키면 중지한다.
