# Development log / 개발 기록

[English introduction](README.md) · [한국어 소개](README.ko.md) · [Full commit history / 전체 커밋 이력](https://github.com/hongwoogi/yourgame/commits/main/)

Dates use Asia/Seoul (KST). This is a sanitized project development log, not a dump of runtime output or participant data. A recorded code change is not proof of a production deployment or a game release. Earlier entries summarize existing commits; they do not claim those versions were retested when this log was created.

날짜는 한국시간(KST) 기준입니다. 운영 원본 출력이나 참여자 데이터를 담지 않는 공개 개발 기록입니다. 코드 변경 기록은 운영 배포·게임 공개의 증거가 아닙니다. 과거 항목은 기존 커밋을 요약하며, 기록 작성 시점에 해당 버전을 다시 검증했다는 뜻은 아닙니다.

## 2026-09-01 — Public project documentation / 프로젝트 공개 문서

- **Why / 이유:** Explore what happens when collective intelligence, like Wikipedia's collaborative knowledge, produces a game. / 위키피디아처럼 집단지성을 모았을 때 그 산출물이 게임이 된다면 어떨지 제시합니다.
- **Changed / 변경:** Make English the default README, add an equivalent Korean README, credit Everyone Draw as inspiration, and introduce this bilingual development log and contribution guidance. Retain the existing source history. / 기본 영문 README와 대응하는 한국어 README를 제공하고 Everyone Draw에서 받은 영감을 명시합니다. 두 언어의 개발 기록과 기여 안내를 추가하며 기존 소스 이력을 보존합니다.
- **Privacy / 공개 범위:** Publish project source, tests, and documentation; keep local operational records and credentials excluded. Extend ignore rules for local database and credential files. / 코드·테스트·문서를 공개하고 로컬 운영 기록·인증정보는 제외합니다. 로컬 DB와 인증 파일의 제외 규칙도 보강합니다.
- **Validation / 검증:** A fresh install of source baseline `4909be4` passed the full build on recheck: 441 tests passed, one optional check skipped, zero failures. The source release's isolated browser run passed 162 tests. The documentation candidate also passed the complete backend/core suite with serial test execution. Relative documentation links resolved. Gitleaks scans of available Git history and the new documents, plus a private exact-value comparison against configured secrets, found no secrets. Automated scans do not guarantee the absence of all sensitive information. / 소스 기준 `4909be4`를 새로 설치한 뒤 전체 빌드 재검사에서 441개 통과·선택 검사 1개 건너뜀·실패 0건을 확인했습니다. 해당 소스 공개 작업의 격리된 브라우저 검사도 162개 통과했습니다. 문서 후보 역시 백엔드·코어 전체 검사를 순차 실행하여 통과했습니다. 문서의 상대 링크도 확인했습니다. Git 이력·새 문서의 Gitleaks 검사와 설정된 비밀값의 비공개 일치 검사에서 비밀정보를 발견하지 못했습니다. 자동 검사만으로 모든 민감정보의 부재를 보장하지는 않습니다.
- **Failure and recheck / 실패와 재검사:** Two parallel archive builds encountered intermittent Windows native-process crashes, first in game-publication-store tests and then in operator-safety-review tests. The cause remains unknown. Both affected suites passed independently (25 and 5 tests); a full build recheck and the complete serial suite passed. Preserve the failed attempts as private evidence; the passing runs do not establish a fix for the intermittent crash. / 병렬 archive 검사 두 번에서 게임 공개 저장소와 운영자 안전 검토 테스트 프로세스가 각각 간헐적인 Windows 네이티브 오류로 종료됐습니다. 원인은 미확인입니다. 해당 단독 검사 25개·5개와 전체 빌드 재검사, 전체 순차 검사는 통과했습니다. 실패 증거는 비공개로 보존하며, 재검사 통과를 간헐 종료의 원인 해결로 해석하지 않습니다.
- **Limits / 한계:** This documentation change does not alter gameplay, authentication, production data, or game-release approval. No open-source license is selected by this change. / 게임·인증·운영 데이터·게임 공개 승인을 변경하지 않으며 오픈소스 라이선스를 임의로 선택하지 않습니다.

## 2026-09-01 — Daily collection schedule / 일일 의견 수집 일정

- **Changed / 변경:** Implement a daily 23:00 KST opinion cutoff and the next midnight release target, guarded daily-cycle operator commands, and schedule-aware UI. Configure the existing local recurring workflow for that schedule. Preserve text entered before the JavaScript module loads instead of overwriting it with a saved draft. / 매일 한국시간 23시 의견 마감과 다음 자정 공개 목표, 검증을 거치는 일일 회차 운영 명령, 일정에 맞춘 UI를 구현했습니다. 기존 로컬 반복 작업에 일정을 연결했습니다. JavaScript 모듈이 로드되기 전에 입력한 내용을 저장된 초안으로 덮어쓰지 않도록 수정했습니다.
- **Evidence / 근거:** Commit [`4909be4`](https://github.com/hongwoogi/yourgame/commit/4909be4d89da79a09207d7105ed9404e231f9371) and the [daily runbook](docs/daily-release-runbook.md). / 해당 커밋과 [일일 운영 절차](docs/daily-release-runbook.md)를 참고하세요.
- **Validation / 검증:** The deployment operator confirmed the archive build (441 passed, one optional skip), all 162 browser tests, live asset/commit matching, the schedule on 390px and 1440px screens, and preservation of the current game and participant records. The first scheduled cycle closes September 1 at 23:00 KST, targeting September 2 at 00:00 KST. / 배포 담당자가 archive 빌드 441개 통과·선택 검사 1개 건너뜀, 브라우저 검사 162개 통과, 실제 제공 파일·커밋 일치, 390px·1440px 화면의 일정 표시, 현재 게임·참여자 기록 보존을 확인했습니다. 첫 예약 회차는 9월 1일 23시 마감·9월 2일 00시 공개 목표입니다.
- **Limits / 한계:** The schedule is a target, not a guarantee of an on-time release. The operator's PC and Codex app must remain running. Failed validation keeps the last verified game. This app deployment does not itself publish a new daily game; `v1-20260901` remains selected. / 일정은 목표이며 정시 공개를 보장하지 않습니다. 운영자의 PC와 Codex 앱이 켜져 있어야 하며 검증 실패 시 마지막 검증 게임을 유지합니다. 이번 앱 배포에서 새 일일 게임을 공개한 것은 아니며 `v1-20260901` 선택을 유지했습니다.

## 2026-09-01 — First game implementation / 첫 게임 구현

- **Changed / 변경:** Add the mobile hex roguelike, English/Korean game content, an isolated runtime, versioned local saves, and reviewed publication controls. / 모바일 육각형 로그라이크, 영문·한글 게임 콘텐츠, 격리 런타임, 버전별 로컬 저장, 검토 기반 공개 제어를 추가했습니다.
- **Evidence / 근거:** Commit [`ccd86f1`](https://github.com/hongwoogi/yourgame/commit/ccd86f180b92c057657e5757857a5d5c3caacb89) contains the implementation and its tests. This entry records code history, not a new assertion of live-play verification. / 해당 커밋에 구현과 테스트가 있습니다. 이 항목은 코드 이력이며 운영 플레이를 새로 검증했다는 선언은 아닙니다.

## 2026-08-31 — Community and game workflow / 커뮤니티와 게임 제작 흐름

- **Changed / 변경:** Add public proposals and voting, editable public names, personal ranking and the full idea browser, bilingual UI, mobile layout refinements, Google sign-in fixes, and five game-development role definitions. / 공개 의견·투표, 공개 별명 변경, 내 순위·전체 의견 탐색, 두 언어 UI, 모바일 배치 개선, Google 로그인 수정, 게임 제작 다섯 역할을 추가했습니다.
- **Evidence / 근거:** Commits `56f422e`, `79438e7`, `9c97614`, `eeca407`, `0ae1d91`, `9b93982`, `9ea40f9`, `1dd3efa`, and `ecffe4e`; historical validation details are in [infrastructure status](docs/infrastructure-status.md). / 해당 커밋과 [인프라 기록](docs/infrastructure-status.md)에 과거 검증 내용이 있습니다.
- **Limits / 한계:** Mocked login tests and a visible Google button do not prove successful real-account authentication. Role definitions alone do not prove isolated execution or game release. / 모의 로그인 검사와 Google 버튼 표시는 실계정 인증 성공을 증명하지 않습니다. 역할 정의만으로 실행 격리나 게임 공개가 증명되지 않습니다.

## 2026-08-31 — Project foundation / 프로젝트 기반

- **Changed / 변경:** Record the concept and infrastructure plan; add the website, Google sign-in and limited proposal collection, protected administration, safety review, health checks, and recovery procedures. / 기획·인프라 계획을 기록하고 웹사이트, Google 로그인·제한된 제안 접수, 보호된 관리 기능, 안전 검토, 상태 점검·복구 절차를 추가했습니다.
- **Evidence / 근거:** Existing history from `a1dfdfb` through `426c68c`, plus the health-test portability fix `c5e28dd`. See the [launch runbook](docs/launch-runbook.md) and [safety policy](docs/participation-safety.md). / `a1dfdfb`부터 `426c68c`까지의 기존 이력과 상태 검사 이식성 수정 `c5e28dd`를 근거로 합니다. [운영 절차](docs/launch-runbook.md)와 [안전 기준](docs/participation-safety.md)을 참고하세요.

## Recording future work / 이후 기록 방법

Add a dated entry for meaningful work with its reason, changes, checks actually performed, and unresolved limits. Link the relevant commit or pull request when available. Clearly distinguish planned, implemented, deployed, and verified behavior. Record confirmed failures and their resolution without publishing raw logs, identities, proposal text, credentials, or private fingerprints. Keep the English and Korean summaries aligned.

의미 있는 작업에는 날짜, 이유, 변경 내용, 실제 수행한 검사, 남은 한계를 기록합니다. 가능한 경우 관련 커밋이나 PR을 연결합니다. 계획·구현·배포·실검증을 구분하고 확인된 실패와 해결 내용을 남기되, 원본 로그·신원·제안 원문·인증정보·비공개 지문은 공개하지 않습니다. 영어·한국어 요약의 내용을 맞춥니다.
