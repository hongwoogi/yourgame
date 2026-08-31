# 공개 의견·투표·기여도 API

제안은 별도 공개 동의나 안전 승인 없이 저장 직후 공개되고, 열린 실제 회차에서는 투표할 수 있다. 접수 단계에 콘텐츠 규칙 필터를 적용하지 않는다. Google 인증·UTF-8 2,000바이트·최근 60분 신규 3개·운영/회원 제어는 유지한다. 게임 표시는 실제 검증된 공개 상태를 따르며, 검증된 게임이 없으면 `/api/status`의 `game.published=false`와 준비 화면을 유지한다. UI는 [언어 지원 기준](localization.md)을 따른다.

## 조회

`GET /api/community` 또는 `?view=public`은 익명으로 조회할 수 있다. 세션을 만들거나 Google 이름·이메일을 공개하지 않는다. 기본값은 현재 투표 회차의 의견이며 `includeClosed=1`이면 마감된 공개 의견도 포함한다. `includeClosed`는 `0` 또는 `1`만 허용하며 생략하면 `0`이다. 그 밖의 쿼리나 중복 키는 허용하지 않는다. 최근 의견과 인기 의견은 각 최대 6개, 호환용 리더보드 응답은 최대 10명이며 메인 화면은 그중 상위 5명만 표시한다.

```text
{
  recent: PublicIdea[], popular: PublicIdea[], includeClosed: boolean,
  leaderboard: { items: [{ rank, author: { id, alias }, points, adoptedCount }] },
  round: { id, status, closesAt, limit: 3 } | null,
  publicationPolicy: { version: 'public-default-v1', defaultPublic: true },
  scoring: ContributionPolicy,
  serverTime
}

PublicIdea = {
  id, body, proposalRevision, publicationRevision,
  author: { id, alias }, createdAt,
  upvotes, downvotes, votingOpen, roundId
}
```

공개 식별자는 내부 회원·제안 식별자와 다르다. 현재 원문과 공개 generation이 일치하고, 작성자가 정상 회원이며 관리자가 운영 제외하지 않은 제안을 반환한다. 명시적으로 숨긴 제안은 제외한다. 게임 개발용 안전 검토의 대기·승인·보류·차단 상태는 공개나 투표의 선행 조건이 아니다. 안전 심사 사유·해시·개발 정리문·Google 이름/이메일·개인별 투표 내역은 포함하지 않는다. 인기순은 유효한 찬성 수에서 반대 수를 뺀 값, 찬성 수, 최신 접수 시각, 고정된 식별자 순이다.

`GET /api/community?view=leaderboard&offset=0&limit=20`은 전체 공개 순위의 한 페이지를 익명으로 반환한다. 세션을 만들지 않고 캐시하지 않는다. `offset`은 0 이상의 안전한 정수, `limit`은 1~50이며 생략 시 각각 0과 20이다. 알 수 없거나 중복된 쿼리는 거절한다.

`GET /api/community?view=ideas&sort=recent&offset=0&limit=24`는 현재 투표 회차의 공개 의견을 페이지로 반환한다. `includeClosed=1`을 추가하면 마감된 의견도 포함하며 `0` 또는 생략은 현재 회차만 읽는다. `sort`는 `recent` 또는 `popular`이며 생략하면 `recent`다. `offset`은 0 이상의 안전한 정수, `limit`은 1~50이고 기본값은 각각 0과 24다. 응답은 `{ items: PublicIdea[], sort, offset, limit, total, hasMore, includeClosed, round, publicationPolicy, serverTime }`이다. 메인 피드와 같은 공개 범위·별명·정렬 규칙을 사용하고, 목록·전체 개수·회차·시간을 같은 읽기 트랜잭션에서 계산한다. 범위를 넘은 페이지는 빈 목록과 실제 `total`, `hasMore: false`를 반환한다. 쿼리의 중복·미지원 키·잘못된 값은 422로 거절하며 익명 조회에 세션 생성이나 쿠키 설정을 하지 않는다.

의견 더보기 모달은 24개씩 표 형태로 탐색하고 같은 투표 API를 사용한다. 상단의 모든 의견 보기 필터는 메인과 모달에 함께 적용한다. 본인 의견도 현재 회차 목록에 남기되, 본인 배지와 자기 투표 금지를 유지한다. 다른 페이지의 의견에도 회차별 3표·최신 본문 및 공개 revision 검사를 적용한다. 새 제안이나 투표로 서로 다른 조회 사이의 순서는 달라질 수 있으므로 페이지 목록을 영구 고정된 결과로 해석하지 않는다. 새로고침·정렬 변경·로그인·언어 전환·전체 보기 전환은 투표를 자동 실행하지 않는다.

```text
{
  items: [{ rank, author: { id, alias }, points, adoptedCount }],
  offset, limit, total, hasMore
}
```

전체 공개 참여자의 정확한 기여도를 먼저 합산하고 순위를 결정한 뒤 페이지를 자른다. 같은 점수는 같은 순위이며 다음 순위는 해당 인원만큼 건너뛴다(예: 1, 1, 3). 동점의 표시 순서는 고정된 공개 식별자로 정하므로 별명을 바꾸어 순서가 달라지지 않는다. `total`은 이 조회에서 순위 대상인 참여자 수이며 숨긴 프로필이나 정지 회원은 제외한다.

`GET /api/community?view=me`는 로그인한 본인만 조회한다. 회원 식별자는 서버의 유효한 세션에서 결정하고 응답에 `ownerId`를 포함해 브라우저가 계정 변경 후 낡은 응답을 표시하지 않게 한다. 리더보드에서 숨긴 참여자도 개인 기여도를 확인할 수 있다.

```text
{
  ownerId,
  profile: { id, alias, leaderboardVisible, revision, visibilitySource },
  publicationPolicy: { version: 'public-default-v1', defaultPublic: true },
  contribution: { points, adoptedCount, rank },
  voteQuota: { roundId, limit: 3, used, remaining, closesAt },
  votes: [{ publicId, direction, proposalRevision, publicationRevision, roundId }],
  publications: [{ proposalId, proposalRevision, publicationRevision, publicId, requested, eligible, visibilitySource }]
}
```

`points`는 반점까지 정확한 표시 단위 문자열이다. 음수나 소수점이 있는 값을 정수로 반올림하거나 브라우저에서 임의로 합산하지 않는다. `rank`는 전체 공개 순위의 양의 정수이고 비공개 프로필은 `null`이다. 상위 5명 밖의 본인 순위도 서버에서 계산하며, 숨긴 참여자의 개인 점수를 숨기거나 공개 순위에 끼워 넣지 않는다. 생성 별칭의 리더보드 공개는 기본값이며 명시적 숨김은 유지한다. 원장이 없으면 실제 0점 또는 빈 목록을 보여준다. Google 이름·이메일을 별칭으로 복사하지 않는다.

`publications.proposalRevision`은 현재 공개 상태에 연결된 본문 revision이다. 저장 시 같은 트랜잭션에서 최신 본문으로 이동하며 `publicationRevision`이 증가한다. 호환 필드 `requested`는 기본 공개 또는 마지막 명시적 선택에 따른 현재 노출 의사값이지, 사용자가 동의 버튼을 눌렀다는 증거가 아니다. `visibilitySource`는 `service_default` 또는 `author_choice`로 그 차이를 표시한다. `eligible`은 실제 현재 피드 노출 가능 여부다. 상태 변경에는 현재 `proposalRevision`과 마지막 `publicationRevision`을 함께 보내고, 다른 탭에서 바뀌면 충돌로 거절한다.

## 변경

모든 변경은 `POST /api/community`, JSON, 같은 출처, 유효한 로그인·CSRF 토큰을 요구한다. 공통 `requestId`를 사용하며 응답이 불확실할 때는 같은 요청 ID와 본문으로 확인한다. 언어 전환·로그인·목록 갱신이 변경을 자동 실행하지 않는다.

변경 시도는 계정당 고정된 1분 구간에 최대 30회로 제한한다. 실패한 입력도 요청 횟수에 포함한다. 초과 시 `COMMUNITY_RATE_LIMITED`와 `Retry-After`를 반환한다. 제안 접수 횟수와 활성 투표 예산은 이 요청 빈도 제한과 별개다.

| action | 추가 입력 | 의미 |
| --- | --- | --- |
| `set_publication` | `proposalId`, `proposalRevision`, `publicationRevision`, `visible` | 본인 제안의 노출 회수 또는 명시적 재공개. 신규 접수에는 불필요하며 최신 revision을 사용한다. 0은 행이 없는 옛 계약 호환값이다. |
| `set_profile_visibility` | `visible`, `revision` | 공개 별명과 기여도를 리더보드에 공개할지 선택 |
| `set_profile_alias` | `alias`, `revision` | 본인의 공개 별명을 변경. 현재 프로필 revision을 사용하며 계정·투표·기여 이력은 유지 |
| `vote` | `publicId`, `proposalRevision`, `publicationRevision`, `roundId`, `direction=up/down/none` | 다른 사람의 현재 공개 의견에 찬성·반대하거나 기존 표 취소 |

새 공개·리더보드 참여·별명 변경·투표에는 서비스 활성 상태와 참여 허용 설정도 필요하다. 공개 의견·프로필의 노출 회수는 유효한 로그인 아래 점검·종료 중에도 허용한다. 제안 원문이나 감사 이력을 삭제하지 않는다.

별명은 앞뒤 공백 제거와 NFC 정규화 후 2~24 Unicode 코드포인트, UTF-8 96바이트 이하로 제한한다. 문자·결합 문자·숫자·ASCII 공백과 `_`, `.`, `-`를 허용하며 제어 문자·보이지 않는 문자·HTML·이모지·연락처/URL 구분 문자는 허용하지 않는다. 잘못된 형식은 `INVALID_PROFILE_ALIAS`로 거절한다. 이 형식 검사는 제안 본문의 콘텐츠 사전 필터와 별개다. 같은 별명은 허용하며 본인 여부는 항상 공개 식별자로 판정한다. 이름 변경은 프로필 revision·변경 이력·멱등 영수증과 한 트랜잭션으로 저장한다. 다른 탭의 별명/프로필 변경과 충돌하면 최신 상태를 다시 읽어야 한다. 생성된 원래 별명과 공개 식별자는 유지하고 표시 이름만 별도 저장한다.

투표 예산은 제출 횟수와 별도로 회차당 찬반 합산 활성 3표다. 같은 의견의 방향 전환은 슬롯을 추가로 쓰지 않고 마감 전 취소는 슬롯을 돌려준다. 자기 투표·다중 동시 요청으로 네 번째 활성 표·마감 후 변경은 서버에서 거절한다. 본문 수정·공개 회수·회원 정지·운영 제외로 무효화한 표는 재공개·복구 후 자동 부활하지 않는다. 본문/hash, 공개 generation, 작성자/투표자 회원 제어 revision, 운영 검토 revision을 비교한다. 게임 안전 심사의 상태/revision 변경만으로는 표를 무효화하지 않는다. 기존 투표 테이블의 안전 심사 ID/revision은 이전 스키마와 호환되는 참고 기록일 뿐 현재 집계 조건이 아니다.

최초 모집은 2026-08-31 23:00 KST에 마감됐다. 이후 제안은 최초 작성 시각으로 계산한 실제 일별 회차 `daily-YYYY-MM-DD`에 연결하며 날짜는 KST 마감일이다. 구간은 전날 23:00부터 당일 23:00 직전까지이고 정확히 23:00인 제안은 다음 회차다. 현재 회차에는 찬반 합산 3표를 주며 마감된 회차는 읽기만 허용한다. 기존 `pending` 저장값과 이전 표는 보존한다. 제안이 없는 날짜의 조회도 정확한 현재 회차를 계산하되 DB를 쓰지 않고, 새 제안을 저장할 때 영속 회차를 함께 추가한다. 실제 투표는 저장된 회차·제안 작성 시각·현재 DB 시각이 일치해야 한다.

## 점수와 게임 공개의 경계

접수된 원문과 공개 피드는 신뢰하지 않는 데이터다. 게임 개발은 여전히 현재 원문 revision/hash·`teen-v1`·관리자의 명시적 안전 승인과 별도 개발 정리문에 묶인다. 미승인 또는 위험한 입력을 공개했다거나 많은 표를 받았다는 이유로 실행하지 않는다. 수정하면 이전 개발 승인은 무효이며 관리자 승인 시 원문과 정리문의 injection/게임 안전 검사를 유지한다.

안전 승인이나 개발 요청 완료로 기여도를 발행하지 않는다. 실제 게임 공개·구체적인 충족 근거·확정된 배점 정책·마감 전 유효한 투표가 필요하다. 확정 정책은 작성자 `100 + 찬성 × 5 − 반대 × 2`, 유효한 사전 찬성자 `10 + 찬성 − 반대 × 0.5`인 `contribution-weighted-v1`이다. 같은 실질적 변화·참여자의 중복 지급과 제안자·투표자 겸임 중복을 막는다. [신뢰된 로컬 정산](contribution-settlement.md)만 불변 공개·반영·투표 근거를 검사해 원장을 발행하며, 기존 공개용 `settle`은 계속 `RELEASE_REVIEW_UNAVAILABLE`로 닫혀 있다. 관리자·브라우저가 임의 점수나 공개 성공을 입력하는 API는 제공하지 않는다.

공개 수와 인기도, 기여도 총점으로 Teen 기준·인증·운영 제어를 우회할 수 없다. 점수 규칙의 상세 내용은 [투표·기여도 기준](voting-and-contribution.md)을 따른다.

## 공개 기본값 전환

기존 base/admin/safety/community/contribution schema version은 1을 유지한다. `initializeCommunityDatabase`는 새 정책을 **inactive**로 준비할 뿐 기존 제안을 공개하거나 안전 승인하지 않는다. 별도 `activateCommunityPublicDefaults(client, { expectedServiceRevision })`가 같은 write transaction에서 서비스 active·제안 허용·개발 허용·정확한 운영 revision·현재 본문 이력·필수 트리거를 확인한 뒤 활성화/백필한다. 조건이 다르면 공개 관련 변경도 하지 않는다.

기존 미선택 비공개 제안과 생성 별칭은 `public-default-v1` 서비스 정책으로 전환한다. 기존 `community_events`의 실제 작성자 선택을 기록 순서로 복원하여 마지막 명시적 hide를 보존하고, 이후 명시적 show가 있으면 그 최신 선택을 존중한다. 옛 프로필의 기본값 0만 보고 숨김 선택으로 해석하지 않는다. 자동 공개는 옛 `community_publications.requested=1`이나 사용자 동의 이벤트를 만들어 위장하지 않고 별도 default 출처/시스템 이력으로 남긴다.

현재 본문이 `proposal_body_revisions`에 저장되는 트리거에서 별칭과 공개 generation을 함께 갱신하므로, 활성화 뒤 도착한 옛 배포의 신규/수정 요청도 같은 트랜잭션으로 반영한다. 명시적 숨김은 수정·초기화·반복 백필로 사라지지 않는다. 혼합 배포 기간에는 DB 투표 상한 트리거가 이전 코드의 안전 심사 기반 집계로도 네 번째 표를 배정하지 못하게 한다.

새 서버의 접수는 정책 미활성 또는 필수 트리거 누락 시 `COMMUNITY_SCHEMA_UNAVAILABLE`로 실패하며 접수 횟수를 쓰거나 본문을 부분 저장하지 않는다. 운영 순서는 비활성 준비 → 운영 제어 재확인과 활성화/백필 → 새 코드 배포 → 본문 보존/공개 집계/health 검증이다. 구 코드로 되돌리면 옛 공개 조건 때문에 일부 피드가 숨겨질 수 있지만 데이터나 안전 심사를 되돌리지는 않는다. 실제 적용은 [운영 절차](launch-runbook.md)를 따른다.
