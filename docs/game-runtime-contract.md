# 게임 실행·저장 계약

2026-08-31 사용자 요청의 다섯 기본 조건을 유지한다. 이 문서는 게임 공개나 생성 완료의 증거가 아니다.

| 사용자 조건 | 구현 계약 | 현재 검증 범위 |
|---|---|---|
| 9:16 모바일 기준 | 메인 `.preview-surface` 안의 9:16 세로 화면. 플레이 화면과 각 정보 페이지는 내부 스크롤 없이 완결하고, 넘치는 내용은 명시적 이전/다음 페이지로 분리. 터치와 키보드, EN/KO 지원 | 390px 터치·1440px에서 가로/세로 overflow와 조작 흐름 검사 |
| 로그라이크 | 승인된 시나리오에서 탐험·선택·전투·보상 성장·종료·재도전 루프 확정 | 결정적 규칙·밸런스와 실제 브라우저 플레이 검사 |
| DB 로컬 저장 | 게임 진행만 브라우저 IndexedDB에 저장. 계정·제안의 기존 운영 DB는 이동하지 않음 | 저장 어댑터 단위/브라우저 검사 |
| 버전별 DB 구분 | 불변 게임 버전마다 `yourgame:save:<gameVersion>` DB 분리 | 버전 격리, 새로고침, 동시 저장 충돌 검사 |
| 메인 페이지 시연 | 승인된 게임을 기존 메인 영역에 sandbox iframe으로 임베드. 로그인·제안 UI와 게임 실행을 분리 | 저장 MessagePort, 외부/API 요청 차단, 프레임 교체·일시정지 검사 |

## 9:16 무스크롤 페이지 규칙

게임 루트는 모든 상태에서 `overflow:hidden`을 유지한다. 메뉴·플레이·도움말·보상·성장·일시정지·승리·패배는 각각 한 9:16 화면에 들어가는 독립 페이지다. 장문 규칙, 상세 설명, 기록 또는 선택지가 한 화면을 초과하면 글자를 잘라 숨기거나 내부 스크롤을 열지 않고 이전/다음 버튼이 있는 별도 페이지로 나눈다. 페이지 전환은 게임 규칙 상태나 저장 revision을 임의로 바꾸지 않는다.

검증은 9:16 프레임 비율뿐 아니라 각 페이지의 `scrollWidth <= clientWidth`, `scrollHeight <= clientHeight`, 조작 요소의 프레임 내부 위치를 모바일·PC와 EN/KO에서 확인한다. 전체화면에서도 9:16을 늘이거나 자르지 않고 중앙 letterbox로 유지한다.

## 검토된 로컬 이미지 에셋

번들 schema v2는 카드별 PNG manifest만 허용한다. 각 에셋은 버전 내부 `assets/` 상대 경로, MIME, 정확한 바이트 수, SHA-256, 폭·높이에 묶이며 외부 URL·data URL·SVG·임의 HTML/CSS는 받지 않는다. 신뢰된 호스트가 `credentials:omit`으로 같은 버전 파일을 제한 크기로 읽고 PNG signature와 해시를 확인한 뒤 ArrayBuffer를 프레임에 전달한다. 프레임은 실제 픽셀 크기를 다시 확인하고 `blob:` URL만 표시하며 `connect-src 'none'`을 유지한다.

ImageGen 같은 제작 도구는 승인된 독립 아트 브리프만 받고 참여자 원문·운영 권한·DB·비밀을 받지 않는다. 생성 결과는 후보의 자산 inventory, release `assetsDigest`, 공개 버전 디렉터리와 `game-archive/<version>/`에 같은 바이트로 보존한다. 제작 도구 출력만으로 안전 승인이나 공개 승인이 되지 않는다.

## 로컬 저장 API

`public/game-save-store.js`는 호스트가 소유한다. `createGameSaveStore(gameVersion)`의 `load()`는 저장이 없을 때만 `null`을 반환한다. `save(data, {expectedRevision})`는 새 저장이면 0, 기존 저장이면 마지막으로 읽은 revision을 요구한다. 같은 버전의 다른 탭에서 먼저 저장하면 `SAVE_CONFLICT`이고 기존 데이터를 덮어쓰지 않는다.

레코드는 `{schemaVersion:1, gameVersion, revision, data}`다. DB 구조 버전(1)과 게임 콘텐츠 버전은 별개다. JSON은 UTF-8 256KiB, 깊이32, 노드10,000으로 제한한다. 손상·용량 초과·사용 불가는 오류이며 성공이나 빈 저장으로 바꾸지 않는다. 삭제·자동 초기화·다른 버전에서의 자동 이관은 없다. 새 버전 실패나 복귀 시 이전 버전 DB도 보존한다. 브라우저 데이터 삭제, 저장 공간 정리, 사생활 보호 모드의 제한까지 영구 보존한다고 보증하지 않는다. 클라우드 동기화는 하지 않는다.

## 게임에 제공할 제한된 저장 연결

`public/game-save-bridge.js`의 `attachGameSavePort(port, gameVersion)`은 호스트가 지정한 한 버전만 다룬다. 별도 MessagePort를 통해 다음 두 요청만 허용한다.

```json
{"protocol":1,"type":"save:load","requestId":"load-1"}
```

```json
{"protocol":1,"type":"save:write","requestId":"save-1","expectedRevision":0,"data":{"seed":42,"turn":1}}
```

응답은 `save:result`이며 동일 requestId, 호스트의 gameVersion, ok와 record 또는 고정 오류 코드만 포함한다. 게임은 버전·DB 이름·URL·계정·세션·관리 명령을 지정할 수 없다. 미지 필드와 잘못된 메시지는 무시하고, 동시 작업은 SAVE_BUSY로 거절하며, 초기 60개/초당 1개 보충 한도로 처리한다. 초과 요청에는 응답하지 않는다. 따라서 호출자는 시간 제한 후 자동 덮어쓰기하지 말고 마지막 저장을 다시 읽어야 한다. 닫힌 연결은 진행 중 결과도 전달하지 않는다.

메인 앱은 검토된 정확한 프레임에만 이 포트를 전달한다. MessagePort 자체는 공개 승인이 아니며 DOM·쿠키·인증·네트워크·탐색 차단, 일시정지/재개와 프레임 교체 시 포트 폐기를 실제 브라우저에서 계속 검증한다. `allow-same-origin`은 사용하지 않고 게임 편의를 위해 사이트 CSP를 넓히지 않는다.

## 공개 경계

후보 생성과 브라우저 검증이 성공해도 공개 완료가 아니다. 현재 input-gate, 정확한 source/assets/runtime digest, 독립 의미 검토, 불변 release receipt, 전체 build/UI, 새 git archive 설치/build, 실제 운영 배포와 플레이 관측을 순서대로 확인한다. 실패하면 마지막 검증 정상 게임과 저장을 유지하며 검사를 삭제하거나 JSON 승인값으로 대체하지 않는다.
