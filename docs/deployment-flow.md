# PC에서 시작하는 Git 연동 배포

상태: GitHub·Vercel 연결과 준비 페이지 자동 배포는 완료했다. 로컬 게임 변경 작업자와 공개 집계 기능은 아직 구현하지 않았으며 공개 시각 정책도 미정이다. 실제 연결 현황은 [인프라 연결 상태](infrastructure-status.md)를 따른다.

## 역할과 경로

Turso Free에 제안과 회차 상태를 보관한다. 개인 PC가 확정된 회차를 가져와 Codex로 게임을 변경하고 로컬 검증을 수행한다. 검증된 코드를 연결된 GitHub 저장소의 운영 브랜치에 push하면 Vercel이 빌드와 배포를 시작한다.

GitHub의 hongwoogi/yourgame 비공개 저장소와 Vercel의 yourgame 프로젝트를 연결했다. main push에서 production 배포가 생성되고 yourga.me에서 준비 페이지가 HTTPS로 응답하는 것을 확인했다. Turso Starter DB yourgame을 만들고 production 환경에 연결했다. 받은 운영 환경변수로 로컬에서 SELECT 1 쿼리가 성공했으며, 게임 API와 데이터 스키마는 아직 구현하지 않았다.

Vercel Cron은 사용하지 않는다. 기존에 합의한 주기는 PC 측 작업자가 관리하는 방향이며, 매 회차 사람이 배포 버튼을 누르는 절차를 새로 요구하지 않는다. 로컬 작업자의 실제 실행 방식은 아직 구현하지 않았다.

운영 브랜치는 Vercel의 Production Branch 설정으로 결정되며 현재 연결에서는 main이다. main push로 production 배포가 생성되는 것을 확인했다. 다른 브랜치는 기본적으로 preview 배포 대상이므로 작업용 브랜치의 배포 성공을 새 게임 공개로 집계하지 않는다. 준비 페이지 배포도 게임 v1 공개나 최초 모집 시작으로 집계하지 않는다. [Vercel Git 연동](https://vercel.com/docs/git)

## 권장 완료 확인

1. 회차별 최종 커밋을 고정하고 로컬 검증 결과를 보관한다.
2. PC가 운영 브랜치에 push한 뒤 상태를 배포 진행 중으로 기록한다.
3. 예상 프로젝트, production 환경, 커밋 SHA에 해당하는 배포 결과를 조회한다.
4. 성공한 해당 배포가 실제 운영 도메인에 연결되었는지 확인하고, 도메인에서 버전 식별자와 기본 실행 상태를 검사한다.
5. 공개 확인을 통과했을 때만 회차를 공개 성공으로 기록하고 버전 집계와 기여 이력을 한 번 갱신한다.

push 성공이나 READY 상태만으로 공개 완료를 판단하지 않는다. READY인 preview 또는 아직 운영 도메인에 연결되지 않은 배포가 있을 수 있다. 현재 운영 도메인이 연결된 배포와 예상 커밋을 함께 확인한다. [운영 배포 상태](https://vercel.com/docs/deployments/promoting-a-deployment#production-deployment-state), [배포 검증](https://vercel.com/docs/deployments/promote-preview-to-production)

기본 Git 연동에서는 Vercel이 빌드를 마치고 공개한 뒤 PC가 이를 확인하게 된다. 공개 후 실행 검사는 공개 전 차단 장치가 아니므로, 이 검사에서 문제가 발견되면 복구 절차가 필요하다. 구체적인 자동 복구 조건은 아직 확정하지 않았다.

상태 확인을 재시도해도 버전 번호나 기여 이력이 중복 갱신되지 않게 한다. 다음 공개가 진행 중인 공개와 겹치지 않도록 직렬 처리한다. 같은 브랜치에 후속 커밋을 연이어 올리면 이전 대기 빌드가 생략될 수 있으므로 공개하려는 커밋을 명확히 추적한다. [Vercel 빌드](https://vercel.com/docs/builds)

## 시간과 실패 처리

기존 합의인 초기 3시간 간격과 성공한 공개 버전 4개마다 간격 1시간 증가 규칙은 유지한다. 정규 배포 1시간 전에 제안과 가중치를 확정하고 제작·검증을 수행한다.

다만 GitHub push 시각과 실제 공개 시각은 같지 않다. 현재 경로에 가장 단순하게 맞는 안은 예정 시각에 배포를 시작하고 Vercel 빌드가 완료되는 대로 공개하는 것이다. 이 지연 허용 여부는 아직 사용자에게 확인하지 않았다.

정확한 공개 시각이 필요하다면 사전에 production 빌드를 완료하고 공개 단계만 분리하는 구조를 검토해야 한다. 일반 preview 배포의 production 승격은 재빌드될 수 있으므로 이를 같은 방식으로 가정하지 않는다. 공개 단계만 분리해도 플랫폼·네트워크 지연까지 없어지는 것은 아니다. [배포 승격 방식](https://vercel.com/docs/deployments/promoting-a-deployment)

PC 응답 없음, 구독 한도 부족, 로컬 검증 실패 또는 공개 전 배포 실패 시 기존 정상 버전을 유지한다. 공개 후 이상이 발견된 경우까지 기존 버전이 유지된다고 단정하지 않으며 복구 상태를 별도로 다룬다. 참여자 안내는 [운영 상태 문구](operations-status.md)를 따른다.

## 무료 운영의 제약

Git push로 시작하는 배포에도 일반 빌드·배포·함수 사용량 한도는 적용된다. Vercel Cron을 사용하지 않는다고 다른 사용량 제한까지 없어지는 것은 아니다. [Hobby 플랜](https://vercel.com/docs/plans/hobby)

Vercel Account Webhooks는 Pro/Enterprise 기능이므로 Hobby 구성의 필수 전제로 삼지 않는다. 로컬 작업자는 제한적인 배포 상태 조회와 실제 운영 URL 확인을 기본안으로 사용한다. [Vercel Webhooks](https://vercel.com/docs/webhooks)

이 경로만으로 구버전 플레이 아카이브가 영구 보존되지는 않는다. 실행 가능한 과거 빌드와 자산의 보관·제공 방식은 별도로 정한다.
