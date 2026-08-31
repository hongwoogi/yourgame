# 매일 의견 마감과 자정 공개

현재 요청에 따른 운영 기준은 **Asia/Seoul 매일23:00 마감 → 다음00:00 공개**다. 첫 일일 회차는 2026-09-01 23:00 마감, 2026-09-02 00:00 공개 목표다. 최초 회차·최초 공개 기록은 변경하지 않는다.

## 예약과 책임

Codex의 이 제작·배포 스레드에 `yourga-me-2` 일일 후속 실행을 등록했다. 매일23:00과00:00에 같은 스레드를 이어간다. 기존 `yourga-me` 시간별 작업은 읽기 전용 장애 관측을 유지하며 제작·배포를 중복 실행하지 않는다. 별도 서버 cron, 유료 API, 새로운 서비스는 없다. 로컬 예약이므로 해당 PC가 깨어 있고 Codex 앱이 실행 중이어야 한다. 예약 등록은 향후 실행·정시 배포 성공의 증거가 아니다.

23시 호출은 입력 고정·제작·검증·후보 준비까지, 자정 호출은 같은 실행의 공개 또는 지연 복구를 담당한다. 준비가 일찍 끝나면 비공개 후보와 진행 기록을 남기고 반환한다. 한 시간을 잠들어 기다리지 않는다. 자정에 진행 중인 동일 작업을 새로 생성하지 않는다.

## 매일 회차와 데이터 보존

- 회차 이름은 마감일 `daily-YYYY-MM-DD`, 루트 개발 실행은 `daily-game-YYYY-MM-DD`다. 범위는 전날23시 이상, 당일23시 미만이다. 정확히23시에 들어온 의견은 다음 회차다.
- 기존 DB의 `initial`/`pending` 식별자와 의견 ID·created_at은 유지한다. 날짜 회차는 불변 최초 작성시각으로 구분한다. 수정 가능 시간도 최초 작성시각이 속한 회차의23시까지이며, 쓰기 SQL이 DB 시각으로 마감을 재검사한다.
- 수정시각이 마감 이후인 의견은 마감된 회차 입력으로 넣지 않는다. 기존 이력을 되감거나 본문을 자동 복원하지 않는다.
- 회차별 원문 검토와 승인 스냅샷은 `.local/daily-cycles/YYYY-MM-DD/`에만 보관한다. 모델에는 정확한 현재 안전 승인 요약·binding만 제공한다. 공개 피드에 보인다는 사실이나 투표수는 개발 승인·공개 승인과 다르다.
- 이 변경은 기존 투표 회차·배점 정책이나 점수 발행을 변경하지 않는다. 계정·원문 이력·표·원장·게임 저장을 초기화하거나 날짜별로 복제하지 않는다. 게임 세이브는 기존의 불변 버전별 로컬 IndexedDB를 유지한다.

##23시: 안전 검토와 후보 준비

1. Git 변경과 실행 소유권을 확인한다. 운영 명령 전에 `node --env-file=.env.production.local scripts/admin-worker.mjs status`를 실행한다. 서비스 중지·취소·다른 작업 소유권은 자동 해제하지 않는다.
2. `node --env-file=.env.production.local scripts/daily-game-cycle.mjs status`로 DB 시각과 마지막 마감 회차를 판독한다. 늦게 시작했어도 처리할 마감일을 명시하고 이미 완료한 회차를 재생성하지 않는다. 날짜가 바뀌었다고 어제의 미완료 기록을 버리지 않는다.
3. 신뢰 운영자만 `exportReviewIntake(client, 'pending')`를 사용해 비공개 원문 검토 자료를 얻고, 해당 회차의 created_at 범위로 ID 집합을 제한한다. `scripts/operator-safety-review.mjs`의 정확한 계약을 읽어 실제 Teen·개인정보·프롬프트 주입·요구 충족 가능성 검토를 수행한다. 본문·비밀값·binding 지문은 콘솔과 Git에 출력하지 않는다. `applyOperatorReview`는 현재 revision/hash에 묶인 실제 판단을 기록하는 도구이며 자동 승인 판정기가 아니다. 검토가 필요한 자료는 held/blocked로 남긴다.
4. `exportDailyRound({client,date})`로 해당 회차의 승인된 입력만 고정한다. 기본 출력은 `.local/daily-cycles/YYYY-MM-DD/snapshot.json`이다. 파일은 불변이고 앞뒤 입력 게이트와 현재 승인 집합을 대조한다. 재실행에서 입력이 달라지면 기존 스냅샷을 덮어쓰지 않고 충돌을 해결한다. 입력이 없으면 새 게임·승인·출시 기록을 만들지 않고 현재 게임 유지 사유를 기록한다.
5. `ensureDailyRun({client,date,workerId})`와 기존 `admin-worker claim`으로 같은 날짜의 실행 하나를 사용한다. 실패·취소·완료 상태를 queued로 되돌리지 않는다. 실패 재시도는 기존 `retry-failed`를 사용하고 parent_id를 보존한다. 다른 실행이 진행 중이면 중복 시작하지 않는다. `admin-worker input-gate --run-id ID --snapshot PATH`를 확인한다.
6. `.local/output-only-probe/live/evidence.json`과 현재 실행 파일·모델 카탈로그·검사 코드의 결합을 확인한다. 앱 업데이트 등으로 증거가 달라졌다면 공개 원문 없이 합성 시험을 다시 통과한 후 진행한다. 일반 공유 디렉터리 서브에이전트를 격리로 간주하지 않는다.
7. 현재 DB에서 공개 검증된 버전을 baseline으로 사용한다. `run-game-team-stage.mjs`에 `--snapshot=PATH --run-id=ID --worker-id=ID --baseline-version=CURRENT --game-version=NEW`를 명시하여 `plan`, `scenario`, 이후 `art`/`gameplay`, `assets`, `validation`을 실행한다. 회차별 신규 버전 예시는 공개일 기준 `v20260902`이며 이미 쓰인 버전은 재사용하지 않는다. 기존 최초 공개 전용 `copyfix`/`balancefix` 단계는 일일 업데이트에서 차단된다. 선언적 JSON으로 구현할 수 없는 요구는 구현 완료로 꾸미지 말고 운영자가 기존 권한 안에서 런타임 변경·검증 필요성을 판단한다.
8. 단계별 입력 gate와 불변 `output/stepNN_*` 바이트 기록을 확인한다. `input/daily-run-binding.json`은 실행 전체의 baseline 버전·검토·선택 revision과 새 버전을 고정한다. 변경되면 `BASELINE_BINDING_CHANGED`로 중단하고 새 실행/검토를 사용한다. 선행 산출물은 실제 바이트와 같은 baseline binding을 대조한다. 완료 단계 재실행은 기록 검증 후 모델 호출 없이 반환한다. 한 단계의 재현 가능한 형식 오류는 `--attempt=2`로 한 번 재시도할 수 있으며 이미 사용한 시도는 `ATTEMPT_ALREADY_USED`다. 산출물만 있고 gate/binding이 없는 중간 저장 실패는 `STAGE_INCOMPLETE`로 보존한다. 증거를 뒤늦게 만들어 붙이거나 덮어쓰지 말고 기존 실패→재시도 자식 실행에서 새로 생성·검토한다. 여전히 실패하거나 선행 산출물이 바뀌면 후속 검토까지 새로 수행한다. 제작 역할의 자기검사는 독립 공개 승인으로 사용하지 않는다.
9. 신뢰 운영자가 후보의 의미·요구 충족·Teen·EN/KO·원작/라이선스·실제 게임 동작을 검토한다. `prepare-game-candidate.mjs`, `validate-game-candidate.mjs`, `npm run build`, 관련 전체 UI 검증을 수행한다. 9:16 터치/키보드, 승패/보상, 일시정지, 새로고침 저장, 버전 간 격리와 인증/admin 접근 차단을 확인한다. 검토 후 `createGameReleaseStore(client).issueReview(...)`로 정확한 스냅샷·후보·런타임·실행 revision·증거에 결합된 영수증을 발급한다.
10. 커밋된 정확한 파일만 새 `.local/` 아카이브에 추출해 `npm ci`와 `npm run build`를 다시 실행한다. Windows에서는 `git -c core.autocrlf=false -c core.eol=lf archive ... HEAD`로 검토한 LF 바이트를 보존하고 추출 후 해시를 대조한다. 머신 전역 Git 설정을 바꾸지 않는다. 자정 전 후보 파일은 비공개로 유지하고 main push/운영 후보 자산 배포·공개 선택을 하지 않는다.

진행 기록은 `.local/daily-cycles/YYYY-MM-DD/`에 실제 실행 ID·현재 단계·snapshot 경로·후보/검토 경로·예정 공개 시각·커밋과 검증 결과를 남긴다. 준비만 된 상태를 published/completed로 표시하지 않는다. 기록은 재개용이며 그 자체가 승인 영수증이 아니다.

##00시: 배포, 확인, 완료

1. 같은 날짜 회차의 진행 기록과 실제 DB 실행·선택 상태를 대조한다. 이미 검증·완료한 회차는 읽기 확인만 하고 끝낸다. 후보가 준비되지 않았다면 기존 게임을 유지하면서 권한 내 수정·재검증을 계속한다.
2. DB 시각이 해당 회차 releaseAt 이상인지 확인하고 현재 입력·운영·독립 검토·정확한 바이트의 `admin-worker release-gate`를 다시 통과한다. `activate`와 `confirm`은 일일 루트 실행과 모든 재시도의 parent 계보에서 시각을 강제한다. 자정 전에는 `DAILY_RELEASE_NOT_DUE`로 거절하며 클라이언트 날짜나 승인 플래그로 우회할 수 없다.
3. 검증한 커밋을 기존 GitHub/Vercel 경로로 배포한다. 직전 검증 게임도 고정 공개 목록과 파일에 유지한다. 배포가 READY이며 운영 도메인에서 검토한 파일 바이트가 일치하는지 확인한 뒤, 최신 selection revision을 사용해 `createGamePublicationStore(client).activate(...)`한다.
4. 메인 페이지에서 실제 게임 버전과 모바일/PC 플레이·EN/KO·저장·격리를 확인한다. 실패하면 기록된 이전 verified 선택으로 rollback하고 실제 복귀를 확인한다. 사용자 DB를 과거 스냅샷으로 덮어쓰지 않는다.
5. 실검증 성공 후 `confirm(...)`, 이어 `admin-worker update --status completed` 순서로 기록한다. 정확한 옵션·releaseBinding은 `docs/game-agent-workflow.md`와 구현 계약을 따른다. 앱 배포 성공이나 HTTP200만으로 게임 출시를 기록하지 않는다.
6. 실제 마감/배포 시각, 버전·URL, 지연 여부와 미검증 항목만 간결히 보고한다. 자정 이후 완료되었으면 지연 배포로 기록한다. 실패한 검사를 삭제하거나 안전 gate를 해제해서 정시 성공을 만들어내지 않는다.

현재 운영 게임이 있는 날 입력이 없으면 정상적으로 유지한다. 새로운 승인 의견도 후보도 없는데 빈 버전을 생성하지 않는다. 누락 회차나 장기 장애는 마지막 완료 회차와 실제 데이터 범위를 대조한 뒤 같은 절차로 복구하며, 매일 같은 기존 의견을 다시 적용하지 않는다.
