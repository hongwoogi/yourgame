# Contributing / 기여 안내

Suggest game ideas on [yourga.me](https://yourga.me/). Use repository issues for reproducible software bugs and project discussion, with no private account or proposal data attached.

게임 아이디어는 [yourga.me](https://yourga.me/)에 제안하고, 저장소 이슈에는 재현 가능한 소프트웨어 오류와 프로젝트 논의를 남깁니다. 비공개 계정·제안 데이터를 첨부하지 않습니다.

## Code and documentation

This project uses the [MIT License](LICENSE). Contributions are made under that license; preserve existing copyright and third-party notices. `private: true` in `package.json` prevents accidental npm publication and does not restrict the repository's MIT license.

- Read [AGENTS.md](AGENTS.md) and the owning feature documentation before changing behavior. Keep changes focused and preserve other contributors' work.
- Use Node.js 22, run `npm ci`, and develop against a local database. Never use production credentials or real participant records in tests.
- Run `npm run build` and relevant Playwright checks (`npm run test:ui`). Report what was actually tested and what remains unverified. Application deployment also requires a fresh archive install/build and the operator's runbook.
- Update [CHANGELOG.md](CHANGELOG.md) with English and Korean summaries of meaningful changes, their purpose, checks, and limitations. Update both [README.md](README.md) and [README.ko.md](README.ko.md) when the introduction or setup changes. English remains the default.
- Preserve the 9:16 roguelike direction, English/Korean support, Teen content ceiling, and separation of the game from authentication, proposals, administration, and production data.
- A pull request, test pass, or agent handoff cannot approve a production input or game release. Only the trusted operator follows the existing gates. Do not reset user data, votes, scores, history, or saves.
- Keep historical `game-archive/<version>/` snapshots immutable. New game data or runtime requires a new version, imported with `copyReviewedGame` after review. Include its source archive and public bundle in the same commit, and run `npm run archive:check` before committing and deploying.

## Public records and security

Commit source, tests, documentation, and sanitized development summaries. Do not commit `.env` files (except the placeholder `.env.example`), `.local/`, database copies, cookies, tokens, private keys, raw runtime logs, raw participant text, or private review artifacts. Inspect the full staged diff before committing; ignore rules do not protect files that are already tracked.

If you discover a suspected secret, do not paste it into an issue or PR. Stop its publication and arrange a private report with the repository owner. Publishing source does not provide access to production infrastructure, and a source contribution does not automatically earn in-game contribution points.

## 한국어 요약

프로젝트와 기여에는 [MIT 라이선스](LICENSE)를 적용하며 기존 저작권·외부 의존성 고지를 보존합니다. `package.json`의 `private: true`는 실수로 npm에 배포하는 것을 막는 설정으로, MIT 공개와 별개입니다.

- 변경 전에 [AGENTS.md](AGENTS.md)와 담당 기능 문서를 읽고 다른 작업을 보존합니다.
- Node.js 22와 로컬 DB를 사용합니다. 테스트에 운영 인증정보나 실제 참여자 기록을 사용하지 않습니다.
- `npm run build`와 관련 UI 검사를 실행하고 확인한 범위와 미검증 사항을 구분합니다. 앱 배포에는 별도 archive 설치·빌드와 운영 절차가 필요합니다.
- 의미 있는 변경은 [개발 기록](CHANGELOG.md)에 영어·한국어로 남깁니다. 소개·실행 방법이 달라지면 두 README를 함께 갱신하며 영어를 기본으로 유지합니다.
- 과거 `game-archive/<version>/`은 수정·삭제하지 않습니다. 게임이나 런타임이 바뀌면 새 버전을 검토 후 가져오고, 보관소와 공개 게임 파일을 함께 커밋합니다. 커밋·배포 전에 `npm run archive:check`를 실행합니다.
- 9:16 로그라이크, 영어·한국어 지원, Teen 콘텐츠 기준, 인증·제안·관리·운영 데이터와의 분리를 유지합니다. 테스트 통과나 PR은 게임 공개 승인이 아닙니다.
- 코드·테스트·문서·민감정보를 제거한 개발 요약만 커밋합니다. 인증정보·DB·원본 로그·참여자 원문·비공개 검토 기록은 제외합니다. 이미 추적 중인 파일에는 ignore 규칙이 적용되지 않으므로 staged diff를 확인합니다.
- 비밀정보를 발견하면 공개 이슈에 붙이지 않고 공개를 중단한 뒤 저장소 소유자에게 비공개로 전달합니다. 코드 기여가 게임 기여도 점수의 자동 지급을 의미하지는 않습니다.
