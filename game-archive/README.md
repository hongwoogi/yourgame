# Game version archive / 게임 버전 보관소

Each version directory preserves its `game.json`, the runtime source files captured with it, and a SHA-256 manifest. New reviewed versions are **added**, never substituted for old ones. Browse the directories above to follow the game's evolution; Git history and commit downloads preserve the surrounding application source as well.

각 버전 폴더에 `game.json`, 당시 런타임 소스, SHA-256 파일 목록을 함께 보관합니다. 새 검토 버전은 이전 버전을 교체하지 않고 **누적 추가**합니다. 위 폴더 목록에서 게임의 발전 과정을 확인할 수 있으며, 주변 앱 전체 소스는 Git 이력과 커밋 다운로드로 보존됩니다.

## First preserved version / 최초 보관 버전

[`v1-20260901`](v1-20260901/) was backfilled from the first game's source commit [`ccd86f1`](https://github.com/hongwoogi/yourgame/commit/ccd86f180b92c057657e5757857a5d5c3caacb89). Its bundle matches the existing public game. Its runtime is the source at that commit, not a later rewritten runtime or a claim that historical browser behavior has been retested today.

첫 게임 소스 커밋에서 `v1-20260901`을 소급 보관했습니다. 게임 데이터는 기존 공개 게임과 일치하며 런타임은 해당 커밋의 소스입니다. 이후 런타임으로 과거 버전을 덮어쓰거나 과거 브라우저 동작을 오늘 재검증했다고 주장하지 않습니다.

## Preservation contract / 보관 원칙

- The trusted `copyReviewedGame` importer captures the exact reviewed bundle and runtime before adding its public artifact. Repeating identical input is safe; a different payload with the same version is rejected. Give every changed game a new version.
- `npm run archive:check` and `npm run build` check manifests, byte hashes, required files, and coverage of public/registered games. A partial import blocks publication until the identical input is completed or the failure is resolved; do not erase a historical version to pass a check.
- In a Git checkout the same checks also protect snapshot files from `HEAD` and its parent against deletion or rewriting, even if the manifest was edited too. A clean `git archive` has no history and instead validates its complete manifest/file set. Vercel production/preview builds may likewise contain only a `.git` marker with no usable `HEAD`; those builds explicitly report unavailable history and still run all manifest/file checks. A broken local checkout remains an error. Keep the Git retention check in the local pre-commit and pre-deployment workflow.
- Keep all version folders and their public game data in subsequent commits, including versions no longer selected by the live service. Do not rewrite an old manifest to legitimize changed bytes.
- A source snapshot can be committed before live verification completes. **Archive presence is not proof of release, release approval, or a safe rollback target.** Record the actual outcome in [CHANGELOG.md](../CHANGELOG.md) only after the existing operator checks. Failed candidates stay identified as failed; the last verified game and all saves remain intact.
- This is a repository source archive, not an older-version browser selector or a standalone offline distribution. Archived copies are not served as executable routes. Do not load old application/auth code into production to inspect a game. The stored frame/runtime and source commit provide the materials for separate local investigation.
- Store only public game/runtime artifacts. No participant exports, credentials, private reviews, operational logs, or save files belong here. The source is covered by the [MIT license](../LICENSE); dependencies keep their own licenses.

신뢰된 가져오기 도구가 검토된 게임·런타임을 함께 보관하며 같은 버전의 다른 내용은 거절합니다. 빌드는 파일 목록·해시·공개 게임의 보관 여부를 검사합니다. 이후 커밋에서도 과거 폴더와 공개 게임 데이터를 삭제하거나 덮어쓰지 않습니다. 보관만으로 공개 승인·출시 성공·복귀 가능 여부를 판단하지 않으며, 실제 결과는 운영 검증 후 개발 기록에 남깁니다. 구버전 선택 UI나 독립 실행 배포본을 추가하는 작업은 아닙니다. 참여자·운영 비공개 데이터와 저장 파일은 포함하지 않습니다.
