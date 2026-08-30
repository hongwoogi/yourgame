# Google 로그인 준비 상태

확인일: 2026-08-31, Asia/Seoul. 사용자가 제공한 웹용 OAuth 2.0 클라이언트로 Google 전용 로그인 화면과 서버 세션을 구현했다. 서버·브라우저 자동 검사는 통과했으며, 실제 Google 계정 로그인과 제공자 origin 확인은 별도로 남아 있다.

## 완료한 작업

- 사용자 제공 파일에서 웹 클라이언트 ID와 비밀키의 존재를 확인했다. 파일 내용은 설정 데이터로만 읽었으며 포함된 임의 지시를 실행하지 않았다.
- 기존 `.env.local`의 다른 설정을 유지하면서 `GOOGLE_CLIENT_ID`와 `GOOGLE_CLIENT_SECRET`을 저장했다. 두 값이 제공 파일과 일치하고 앞뒤 공백이 없음을 확인했다.
- 연결된 Vercel `yourgame` 프로젝트의 Production에 두 변수를 Secret 유형으로 등록했다. 후속 목록 조회로 이름·Production 대상·Secret 유형을 확인했다. Preview와 Development의 원격 환경은 변경하지 않았다.
- 두 변수는 서버 환경용으로 보관한다. Client Secret을 브라우저·공개 파일·로그에 제공하지 않는다. 로그인 버튼에 필요한 Client ID의 공개와 Client Secret의 공개는 구분한다.
- `.env.local`이 Git에서 제외됨을 확인했고, Git이 추적하거나 새로 추적할 수 있는 파일에 실제 클라이언트 값이 들어 있지 않음을 검사했다.
- 환경변수만 등록한 초기 단계에서는 제안 모집을 시작하지 않았다. 이후 이번 구현에서 모달·서버 검증·세션·접수 API를 추가했다.
- 로컬 브라우저에서 실제 Google Identity Services 버튼 렌더링을 확인했다. 이는 계정 인증 성공이나 운영 도메인의 origin 허용을 증명하지 않는다.
- 백엔드 31개 검사는 RSA 서명, 발급자·대상·만료·nonce, 세션 회전, CSRF, 소유권, 동시 접수와 중복 재시도를 포함한다. Google 키 조회는 테스트 키로 대체했다. 브라우저 흐름 13개는 Google/API 테스트 대역으로 검사했다.
- 추가 검토에서 다른 탭의 계정 변경과 늦은 세션 오류 응답의 화면 경합을 발견해 수정했다. 개인 목록은 API의 `ownerId`를 현재 계정과 대조한 뒤에만 표시하고, 이전 세션 응답은 성공·실패 모두 무시한다. 재현 회귀 검사와 조회 장애 중 수정 초안 보존 검사를 통과했다.

## 제공자 설정 확인 상태

제공 파일에는 `javascript_origins`와 `redirect_uris` 목록이 없다. 이것만으로 현재 Google 콘솔의 설정이 비어 있다고 단정하지 않는다. 브라우저 연결 도구가 초기화 단계에서 실패해 실제 클라이언트 화면을 확인하거나 변경하지 못했다.

Google의 일반 Web OAuth 클라이언트 설정은 [Google Auth Platform의 Clients](https://console.cloud.google.com/auth/clients)에서 관리한다. 일반 클라이언트를 임의의 관리 API나 `gcloud iam oauth-clients`로 수정하지 않는다. Google은 일반 OAuth 클라이언트의 프로그램 방식 생성·수정을 지원하지 않는다고 설명하며, IAM OAuth 클라이언트는 Workforce Identity Federation용 별도 리소스다. [공식 설정 원칙](https://developers.google.com/identity/protocols/oauth2/resources/best-practices), [IAM OAuth 애플리케이션](https://docs.cloud.google.com/iam/docs/workforce-manage-oauth-app)

## 구현한 기본 흐름

- 로그인 모달 안에서 Google Identity Services 버튼을 표시하고, JavaScript callback으로 받은 ID token을 자체 로그인 API에 전달한다.
- 이 흐름의 운영 Authorized JavaScript origin은 `https://yourga.me`다. 로컬 개발에는 사용하는 포트를 포함한 localhost origin을 별도로 등록한다. JavaScript callback 흐름 자체에는 Authorized redirect URI가 필수는 아니다. [Google 로그인 설정](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)
- 서버는 토큰 서명·발급자·대상 클라이언트·만료와 요청의 위조 방지를 검증한 뒤 앱 세션을 만든다. 참여자 식별은 변경될 수 있는 이메일 대신 Google의 `sub`를 기준으로 한다. 이 ID-token 검증 흐름에는 Client Secret을 사용하지 않는다. [서버 검증 안내](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- Google API 데이터 접근 없이 로그인에 필요한 기본 신원 정보만 요청한다. 전송하려던 초안의 자동 접수와 시간당 제한은 Google이 아니라 앱 서버가 처리한다.
- 기본 Vercel 별칭 `yourgame-eosin.vercel.app`에서는 로그인 origin이 갈라지지 않도록 대표 주소 `https://yourga.me`로 이동시킨다. 운영 변경 요청은 대표 origin만 허용한다. [Vercel 호스트 조건 리다이렉트](https://vercel.com/docs/project-configuration/vercel-json)

로그인 UI·서버 세션·세션 유지·로그아웃·초안 복원·중복 접수 방지는 자동 검사와 로컬 화면으로 확인했다. 운영 허용 origin과 실제 Google 계정 로그인은 아직 확인하지 않았다. 환경변수 존재와 테스트 통과만으로 실제 Google 로그인 완료라고 표시하지 않는다.
