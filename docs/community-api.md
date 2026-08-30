# 공개 의견·투표·기여도 API

메인 화면은 흰 9:16 게임 미리보기, 제안 입력, 최근 의견·인기 의견, 공개 기여도 리더보드를 제공한다. 미리보기는 실행 가능한 게임이 아니며 `/api/status`의 `game.published=false`를 유지한다. UI는 [언어 지원 기준](localization.md)을 따른다.

## 조회

`GET /api/community` 또는 `?view=public`은 익명으로 조회할 수 있다. 세션을 만들거나 Google 이름·이메일을 공개하지 않는다. 다른 쿼리나 중복 `view`는 거절한다. 최근 의견과 인기 의견은 각 최대 6개, 리더보드는 최대 10개다.

```text
{
  recent: PublicIdea[], popular: PublicIdea[],
  leaderboard: { items: [{ rank, author: { id, alias }, points, adoptedCount }] },
  round: { id, status, closesAt, limit: 3 } | null,
  scoring: ContributionPolicy,
  serverTime
}

PublicIdea = {
  id, body, proposalRevision, publicationRevision,
  author: { id, alias }, createdAt,
  upvotes, downvotes, votingOpen, roundId
}
```

공개 식별자는 내부 회원·제안 식별자와 다르다. 원문·공개 동의·현재 정책의 안전 승인·회원 상태·운영 검토가 유효한 내용만 반환한다. 안전 심사 사유·해시·개발 정리문·이메일·개인별 투표 내역은 포함하지 않는다. 인기순은 유효한 찬성 수에서 반대 수를 뺀 값, 찬성 수, 최신 접수 시각, 고정된 식별자 순이다.

`GET /api/community?view=me`는 로그인한 본인만 조회한다. 회원 식별자는 서버의 유효한 세션에서 결정하고 응답에 `ownerId`를 포함해 브라우저가 계정 변경 후 낡은 응답을 표시하지 않게 한다. 공개 동의 없이도 개인 기여도는 확인할 수 있다.

```text
{
  ownerId,
  profile: { id, alias, leaderboardVisible, revision },
  contribution: { points, adoptedCount },
  voteQuota: { roundId, limit: 3, used, remaining, closesAt },
  votes: [{ publicId, direction, proposalRevision, publicationRevision, roundId }],
  publications: [{ proposalId, proposalRevision, publicationRevision, publicId, requested, eligible }]
}
```

`points`는 반점까지 정확한 표시 단위 문자열이다. 음수나 소수점이 있는 값을 정수로 반올림하거나 브라우저에서 임의로 합산하지 않는다. 리더보드에는 공개에 동의한 별명과 확정 점수만 나오며, 원장이 없으면 실제 0점 또는 빈 목록을 보여준다.

`publications.proposalRevision`은 공개 동의를 저장한 본문 revision이다. 현재 본인 제안의 revision과 다르면 동의가 새 내용에 적용되지 않는다. 재공개 동의·비공개 전환 요청은 현재 본인의 `proposalRevision`과 마지막 `publicationRevision`을 함께 보내며, 다른 탭에서 바뀐 상태는 충돌로 거절한다.

## 변경

모든 변경은 `POST /api/community`, JSON, 같은 출처, 유효한 로그인·CSRF 토큰을 요구한다. 공통 `requestId`를 사용하며 응답이 불확실할 때는 같은 요청 ID와 본문으로 확인한다. 언어 전환·로그인·목록 갱신이 변경을 자동 실행하지 않는다.

변경 시도는 계정당 고정된 1분 구간에 최대 30회로 제한한다. 실패한 입력도 요청 횟수에 포함한다. 초과 시 `COMMUNITY_RATE_LIMITED`와 `Retry-After`를 반환한다. 제안 접수 횟수와 활성 투표 예산은 이 요청 빈도 제한과 별개다.

| action | 추가 입력 | 의미 |
| --- | --- | --- |
| `set_publication` | `proposalId`, `proposalRevision`, `publicationRevision`, `visible` | 본인 제안의 정확한 본문을 공개하기로 동의하거나 노출 회수. 기존 동의가 없으면 publicationRevision=0 |
| `set_profile_visibility` | `visible`, `revision` | 별도 생성 별명과 기여도를 리더보드에 공개할지 선택 |
| `vote` | `publicId`, `proposalRevision`, `publicationRevision`, `roundId`, `direction=up/down/none` | 다른 사람의 현재 공개 의견에 찬성·반대하거나 기존 표 취소 |

새 공개·리더보드 참여·투표에는 서비스 활성 상태와 참여 허용 설정도 필요하다. 공개 의견·프로필의 노출 회수는 유효한 로그인 아래 점검·종료 중에도 허용한다. 제안 원문이나 감사 이력을 삭제하지 않는다.

투표 예산은 제출 횟수와 별도로 회차당 찬반 합산 활성 3표다. 같은 의견의 방향 전환은 슬롯을 추가로 쓰지 않고 마감 전 취소는 슬롯을 돌려준다. 자기 투표·다중 동시 요청으로 네 번째 활성 표·마감 후 변경은 서버에서 거절한다. 본문 수정·공개 회수·심사 철회·정지로 무효화한 표가 재공개·재승인·복구 시 자동 부활하지 않도록 당시 상태에 묶는다.

현재 확정된 투표 구간은 최초 모집의 2026-08-31 23:00 KST 마감까지다. 다음 실제 회차가 정해지기 전에는 `pending` 제안을 무한 투표 예산으로 취급하지 않고 대기 상태로 표시한다.

## 점수와 게임 공개의 경계

안전 승인이나 개발 요청 완료로 기여도를 발행하지 않는다. 실제 게임 공개·구체적인 충족 근거·확정된 배점 정책·마감 전 유효한 투표가 필요하다. 같은 실질적 변화·참여자의 중복 지급과 제안자·투표자 겸임 중복을 막는다. 현재는 신뢰된 게임 공개·충족 증거 발급 경로가 없으므로 원장 발행은 `RELEASE_REVIEW_UNAVAILABLE`로 닫혀 있다. 관리자·브라우저가 임의 점수나 공개 성공을 입력하는 API는 제공하지 않는다.

공유 원문은 신뢰하지 않는 데이터다. 공개 수와 인기도, 기여도 총점으로 Teen 기준·인증·운영 제어를 우회할 수 없다. 공개 동의와 점수 규칙의 상세 내용은 [투표·기여도 기준](voting-and-contribution.md)을 따른다.
