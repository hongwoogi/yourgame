import { i18n } from './i18n.js';

// Keep interface copy separate from participant text and operator announcements.
const copy = {
  "pageTitle": [
    "yourga.me — One roguelike, shaped by your prompts",
    "yourga.me — 프롬프트로 진화하는 로그라이크"
  ],
  "pageDescription": [
    "Help shape one single-player roguelike for desktop and mobile. Share your ideas, then follow the planned cycle of review, Codex development, testing, and release. The first game is still in development.",
    "모두의 프롬프트로 함께 만드는 하나의 PC·모바일 싱글플레이 로그라이크. 제안 수집, Codex 자동 개발, 실행 검증, 공개를 거치며 진화하는 게임, yourga.me."
  ],
  "skipLink": [
    "Skip to the idea form",
    "제안 입력으로 건너뛰기"
  ],
  "home": [
    "yourga.me home",
    "yourga.me 홈"
  ],
  "language": [
    "Language",
    "언어"
  ],
  "mastheadTagline": [
    "A ROGUELIKE WE MAKE TOGETHER",
    "함께 만드는 하나의 로그라이크"
  ],
  "admin": [
    "Admin",
    "관리자"
  ],
  "logIn": [
    "Log in",
    "로그인"
  ],
  "logOut": [
    "Log out",
    "로그아웃"
  ],
  "heroEyebrow": [
    "A ROGUELIKE, SHAPED BY YOUR PROMPTS",
    "당신의 프롬프트로 함께 만드는 로그라이크"
  ],
  "heroLead": [
    "Your prompts.",
    "당신의 프롬프트로,"
  ],
  "heroAccent": [
    "One evolving roguelike.",
    "진화하는 로그라이크."
  ],
  "heroDescription": [
    "One single-player roguelike for desktop and mobile, shaped by everyone's ideas. Submit a prompt; Codex will build from reviewed ideas, with each version tested before release.",
    "모두의 제안으로 함께 만드는 하나의 PC·모바일 싱글플레이 로그라이크.\n프롬프트를 모아 정리하고, Codex가 자동 개발해 검증 후 공개합니다."
  ],
  "firstReleaseIndex": [
    "01 / FIRST RELEASE",
    "01 / 첫 게임 공개"
  ],
  "countdownDefault": [
    "Until the first release",
    "첫 번째 게임 공개까지"
  ],
  "countdownLabel": [
    "Time until the planned first release",
    "공개 목표까지 남은 시간"
  ],
  "days": [
    "days",
    "일"
  ],
  "hours": [
    "hours",
    "시간"
  ],
  "minutes": [
    "min",
    "분"
  ],
  "seconds": [
    "sec",
    "초"
  ],
  "targetLabel": [
    "Planned first release",
    "첫 공개 목표"
  ],
  "targetDate": [
    "Sep 1, 2026 / 00:00 KST",
    "2026.09.01 / 00:00 KST"
  ],
  "koreaTime": [
    "Korea Standard Time (UTC+9)",
    "한국 표준시 (UTC+9)"
  ],
  "clockChecking": [
    "Checking the server time.",
    "서버 기준 시각을 확인하고 있습니다."
  ],
  "reconnect": [
    "Reconnect",
    "다시 연결"
  ],
  "serviceNotice": [
    "Service notice",
    "운영 안내"
  ],
  "collectionChecking": [
    "Checking submissions",
    "제안 모집 상태 확인 중"
  ],
  "initialDeadline": [
    "First-round deadline · Aug 31, 23:00 KST",
    "첫 제안 마감 · 08.31 23:00 KST"
  ],
  "formEyebrow": [
    "YOUR IDEA, OUR NEXT CHAPTER",
    "당신의 아이디어, 우리의 다음 이야기"
  ],
  "formTitle": [
    "What would you add to this game?",
    "이런 게임이면 좋겠어요."
  ],
  "quotaAnonymous": [
    "Log in to share an idea",
    "로그인 후 제안할 수 있어요"
  ],
  "quotaLimit": [
    "Up to 3 submissions per rolling 60 minutes",
    "최근 60분 동안 최대 3개"
  ],
  "editingLabel": [
    "Editing your idea",
    "내 제안 수정 중"
  ],
  "editingNoSlot": [
    "No submission slot used",
    "제출 횟수를 사용하지 않아요"
  ],
  "cancelEdit": [
    "Cancel edit",
    "수정 취소"
  ],
  "placeholder": [
    "For example: I'd love a map that changes each run, with weapons I can craft from materials I find.",
    "예: 탐험할 때마다 지형이 달라지고, 주운 재료로 무기를 만들 수 있으면 좋겠어요."
  ],
  "promptHint": [
    "Small ideas welcome. Specific details help.",
    "작은 아이디어도 좋아요. 구체적일수록 도움이 됩니다."
  ],
  "safetyNote": [
    "Ideas become development candidates after safety review. A new submission uses one slot even while review is pending. Edits go through review again.",
    "접수한 제안은 안전 검토 후 개발 후보가 됩니다. 신규 제안은 검토 대기 중에도 제출 횟수 1회를 사용하며, 수정본은 다시 검토합니다."
  ],
  "safetySummary": [
    "Submission guidelines · Teen content target",
    "제안 안전 기준 · Teen 수준 목표"
  ],
  "safetyRating": [
    "We aim for content at or below ESRB Teen. The game has not received an official ESRB rating.",
    "ESRB Teen 수준 이하를 개발 목표로 삼습니다. 공식 등급을 취득했다는 뜻은 아닙니다."
  ],
  "safetyCombat": [
    "Ordinary fantasy combat ideas are welcome. We don't accept explicit sexual content, sexual objectification or exploitation, gore, dismemberment, or cruel or excessively realistic violence.",
    "일반적인 판타지 전투 요구는 제안할 수 있어요. 과도한 선정성, 성적 행위·대상화·착취, 고어·신체 훼손과 잔혹하거나 과도하게 사실적인 폭력 묘사는 받지 않습니다."
  ],
  "safetyHarm": [
    "Don't submit instructions that encourage dangerous real-world acts, hate, harassment, threats, or exposure of personal information.",
    "현실의 위험 행동을 조장하는 안내, 혐오·괴롭힘·협박과 개인정보 공개는 받지 않습니다."
  ],
  "safetyInjection": [
    "Don't ask to disable safety rules, change system permissions, or reveal personal information or secrets.",
    "안전 규칙 무력화, 시스템 권한 변경, 개인정보·비밀값을 요구하는 지시는 받지 않습니다."
  ],
  "safetyLimits": [
    "We currently use basic checks and manual review. Acceptance or safety approval does not guarantee inclusion or release, and these checks cannot catch every unsafe input.",
    "현재는 기초 검사와 운영자 검토를 사용합니다. 접수나 안전 승인은 게임 반영·공개를 뜻하지 않으며, 위험한 입력을 완벽하게 판별한다고 보장하지 않습니다."
  ],
  "reloadEdit": [
    "Load the latest version",
    "최신 내용 불러오기"
  ],
  "copyEdit": [
    "Use as a new idea",
    "새 제안으로 가져오기"
  ],
  "byteRule": [
    "Up to 2,000 UTF-8 bytes per idea",
    "한 번에 2,000바이트까지"
  ],
  "editRule": [
    "Editable until the round closes · No deletion",
    "모집 마감 전 수정 가능 · 삭제 불가"
  ],
  "send": [
    "Send idea",
    "제안 보내기"
  ],
  "myProposals": [
    "Your submissions",
    "내가 보낸 제안"
  ],
  "reviewEdit": [
    "View and edit",
    "확인하고 수정하기"
  ],
  "collectionFootnote": [
    "Ideas help shape the next version. Not every submission will be included as written.",
    "제안을 모아 다음 게임을 만듭니다. 모든 제안이 그대로 반영되지는 않을 수 있어요."
  ],
  "processEyebrow": [
    "FROM YOUR PROMPT TO THE NEXT VERSION",
    "프롬프트에서 다음 버전까지"
  ],
  "processTitle": [
    "An idea today. A new version next.",
    "한 번의 제안에서, 다음 버전까지."
  ],
  "processIntro": [
    "Different ideas, one shared game. The combat, progression, and rules are ours to figure out together.",
    "각자의 프롬프트가 모여 하나의 게임이 됩니다.\n어떤 전투와 성장, 규칙을 담을지는 함께 정해가요."
  ],
  "processLabel": [
    "How it will work",
    "진행 방식 안내"
  ],
  "processPending": [
    "The first game is still being prepared. The development and release cycle below is planned for the first round; it is not a live progress tracker.",
    "현재는 첫 게임 공개 준비 중입니다. 아래 자동 개발·공개 과정은 첫 회차에 실행될 예정이에요."
  ],
  "processAria": [
    "The development cycle, from submissions to feedback on the next round",
    "제안부터 다음 회차 피드백까지의 개발 순서"
  ],
  "step1Title": [
    "Collect ideas",
    "제안 수집"
  ],
  "step1Body": [
    "Gather everyone's prompts for each round.",
    "모두의 프롬프트를 회차별로 모아요."
  ],
  "step2Title": [
    "Review requests",
    "요구 정리"
  ],
  "step2Body": [
    "Check safety, group similar ideas, and resolve conflicts with the game's rules.",
    "안전 기준을 확인하고 유사 요구·충돌·장르를 검토해요."
  ],
  "step3Title": [
    "Codex builds",
    "Codex 자동 개발"
  ],
  "step3Body": [
    "Turn reviewed requests into game code.",
    "정리된 요구를 바탕으로 게임 코드를 만들어요."
  ],
  "step4Title": [
    "Test the game",
    "실행 검증"
  ],
  "step4Body": [
    "Run the game and check the changes.",
    "게임을 실제로 실행해 변경 사항을 확인해요."
  ],
  "step5Title": [
    "Release a version",
    "새 버전 공개"
  ],
  "step5Body": [
    "Publish a version that passes verification.",
    "검증을 통과한 버전을 공개해요."
  ],
  "step6Title": [
    "Play, then suggest",
    "플레이 후 다시 제안"
  ],
  "step6Body": [
    "Use your play experience to suggest what comes next.",
    "직접 플레이한 경험으로 다음 변화를 제안해요."
  ],
  "processLoop": [
    "What you play informs the next round of ideas",
    "플레이 경험을 다음 회차 제안으로"
  ],
  "policyAria": [
    "What happens if testing or a release fails",
    "검증과 공개 단계의 예외 처리 정책"
  ],
  "validationFailed": [
    "If testing fails",
    "검증 실패"
  ],
  "validationPolicy": [
    "Hold the release; keep the working version",
    "공개 보류 · 기존 정상 게임 유지"
  ],
  "releaseFailed": [
    "If a release breaks",
    "공개 후 장애"
  ],
  "releasePolicy": [
    "Return to the previous working version",
    "이전 정상 게임으로 복귀"
  ],
  "processCaption": [
    "Keeping or restoring a working version only applies once a game has been released. If the first round fails verification, we will delay release and fix the problem.",
    "정상 게임 유지·복귀는 이전에 공개한 게임이 있을 때의 정책입니다. 첫 회차에서 검증에 실패하면 공개를 보류하고 문제를 해결합니다."
  ],
  "footerTagline": [
    "ONE GAME. MANY POSSIBILITIES.",
    "하나의 게임. 수많은 가능성."
  ],
  "footerTogether": [
    "Built together. Played solo.",
    "제안은 함께, 플레이는 각자."
  ],
  "closeLogin": [
    "Close login dialog",
    "로그인 창 닫기"
  ],
  "loginEyebrow": [
    "LET'S MAKE IT YOUR GAME",
    "당신의 아이디어를 게임으로"
  ],
  "loginTitle": [
    "Make your idea\npart of the game.",
    "당신의 아이디어를\n이어갈 차례."
  ],
  "loginDescription": [
    "Log in with Google to share an idea.\nYou can submit up to 3 ideas in any 60-minute period.",
    "Google 계정으로 로그인하고 제안을 남겨주세요.\n최근 60분 동안 최대 3개의 제안을 보낼 수 있어요."
  ],
  "loginPreparing": [
    "Preparing Google login.",
    "Google 로그인 연결을 준비하고 있습니다."
  ],
  "retryGoogle": [
    "Try preparing login again",
    "로그인 다시 준비하기"
  ],
  "draftStored": [
    "Your draft stays in this browser.",
    "작성한 내용은 이 브라우저에 보관됩니다."
  ],
  "noScript": [
    "Enable JavaScript to submit ideas and log in with Google.",
    "제안 작성과 Google 로그인을 이용하려면 브라우저의 JavaScript를 켜주세요."
  ],
  "storageUnavailable": [
    "This browser can't save your draft locally. Copy your text before closing the page.",
    "이 브라우저에서 임시 저장을 사용할 수 없어요. 창을 닫기 전에 작성한 내용을 복사해 주세요."
  ],
  "invalidResponse": [
    "We couldn't read the server response. Please try again shortly.",
    "서버 응답을 확인하지 못했어요. 잠시 후 다시 시도해 주세요."
  ],
  "serverFailed": [
    "Couldn't connect to the server. Your draft is unchanged; please try again shortly.",
    "서버 연결에 실패했어요. 작성한 내용은 그대로 두고 잠시 후 다시 시도해 주세요."
  ],
  "requestFailed": [
    "The request couldn't be completed. Your draft is unchanged. Please check your connection and try again.",
    "요청을 처리하지 못했어요. 작성한 내용은 보관됩니다. 연결을 확인한 뒤 다시 시도해 주세요."
  ],
  "timeout": [
    "The server took too long to respond. Your draft is saved. Please try again shortly.",
    "응답이 늦어 서버 연결을 확인하지 못했어요. 작성한 내용은 보관됩니다. 잠시 후 다시 시도해 주세요."
  ],
  "offlineRequest": [
    "Please check your internet or server connection. Your draft is unchanged.",
    "인터넷 또는 서버 연결을 확인해 주세요. 작성한 내용은 그대로 보관됩니다."
  ],
  "pausedEnded": [
    "The service has ended, so new ideas and edits aren't being accepted. Your draft is saved and will not be sent automatically.",
    "서비스가 종료되어 새 제안과 수정 내용을 접수하지 않아요. 작성한 내용은 보관되며 자동 전송하지 않습니다."
  ],
  "pausedMaintenance": [
    "The service is under maintenance, so new ideas and edits aren't being accepted. Your draft is saved and will not be sent automatically.",
    "서비스 점검 중이라 새 제안과 수정 내용을 접수하지 않아요. 작성한 내용은 보관되며 자동 전송하지 않습니다."
  ],
  "pausedIntake": [
    "Submissions are paused, so new ideas and edits aren't being accepted. Your draft is saved and will not be sent automatically.",
    "제안 접수가 일시정지되어 새 제안과 수정 내용을 접수하지 않아요. 작성한 내용은 보관되며 자동 전송하지 않습니다."
  ],
  "serviceEndedTitle": [
    "The service has ended",
    "서비스가 종료되었습니다"
  ],
  "serviceMaintenanceTitle": [
    "The service is under maintenance",
    "서비스 점검 중입니다"
  ],
  "serviceIntakeTitle": [
    "Submissions are paused",
    "제안 접수를 일시정지했습니다"
  ],
  "serviceDevelopmentTitle": [
    "Automatic development is paused",
    "자동 개발을 일시정지했습니다"
  ],
  "serviceAnnouncement": [
    "Announcement",
    "운영 공지"
  ],
  "servicePausedDetail": [
    "New ideas and edits aren't being accepted. Drafts and past submissions are preserved. You can still log in and view your submissions.",
    "새 제안과 수정은 접수하지 않습니다. 작성한 초안과 기존 접수 내역은 보존되며, 로그인과 내 제안 조회는 계속 이용할 수 있어요."
  ],
  "developmentPausedDetail": [
    "Game development and release are on hold. You can still submit ideas.",
    "새 게임 개발·공개는 대기 중입니다. 제안 접수는 계속 이용할 수 있어요."
  ],
  "timeChecking": [
    "Checking the time",
    "시각 확인 중"
  ],
  "bytesOver": [
    "Remove {bytes} bytes. Some characters and emoji use more than one UTF-8 byte.",
    "{bytes}바이트를 줄여주세요. 한글과 이모지는 한 글자에 여러 바이트를 사용해요."
  ],
  "quotaChecking": [
    "Checking remaining slots",
    "남은 횟수 확인 중"
  ],
  "quotaHistory": [
    "Checking your submissions",
    "제출 기록을 확인하고 있어요"
  ],
  "quotaRemaining": [
    "{remaining} / {limit} submissions left",
    "남은 제안 {remaining} / {limit}"
  ],
  "quotaNext": [
    "Next slot at {time} KST",
    "다음 제출 가능 {time} KST"
  ],
  "quotaRefill": [
    "Each slot returns 60 minutes after you submit",
    "제출한 지 60분이 지나면 횟수가 돌아와요"
  ],
  "saving": [
    "Saving…",
    "저장 중…"
  ],
  "sending": [
    "Submitting…",
    "접수 중…"
  ],
  "intakeEnded": [
    "Submissions closed",
    "접수 종료"
  ],
  "intakePaused": [
    "Submissions paused",
    "접수 일시정지"
  ],
  "editCheck": [
    "Review edit status",
    "수정 상태 확인"
  ],
  "saveEdit": [
    "Save edit",
    "수정 저장"
  ],
  "quotaWaiting": [
    "Waiting for a slot",
    "횟수 충전 대기"
  ],
  "endedTitle": [
    "Service ended",
    "서비스 종료"
  ],
  "maintenanceTitle": [
    "Under maintenance",
    "서비스 점검 중"
  ],
  "developmentTitle": [
    "Development paused",
    "자동 개발 일시정지"
  ],
  "endedMessage": [
    "The service has ended.",
    "서비스 운영이 종료되었습니다."
  ],
  "maintenanceMessage": [
    "Maintenance is in progress.",
    "운영 점검을 진행하고 있어요."
  ],
  "developmentMessage": [
    "Waiting for development to resume.",
    "다음 개발을 기다리고 있어요."
  ],
  "firstGame": [
    "The first game",
    "첫 번째 게임"
  ],
  "gamePublished": [
    "The first game has been released.",
    "첫 게임이 공개되었습니다."
  ],
  "gamePreparingTitle": [
    "Preparing the first release",
    "첫 번째 게임 공개 준비 중"
  ],
  "gamePreparing": [
    "The first game isn't ready yet.",
    "첫 게임을 준비하고 있어요."
  ],
  "countdownTime": [
    "{days} days, {hours} hours, {minutes} minutes, {seconds} seconds until the planned release",
    "공개 목표까지 {days}일 {hours}시간 {minutes}분 {seconds}초"
  ],
  "operationChecking": [
    "Checking the service status again.",
    "운영 상태를 다시 확인하고 있습니다."
  ],
  "deviceTime": [
    "Checking the server connection. Currently showing your device's time.",
    "서버 연결을 확인 중입니다. 기기 시간으로 표시합니다."
  ],
  "pausedReleaseNote": [
    "A release will only be marked complete after service resumes and publication is confirmed.",
    "운영 재개와 새 공개가 확인되기 전에는 공개 완료로 표시하지 않습니다."
  ],
  "publishedNote": [
    "The release status was confirmed by the server.",
    "공개 상태는 서버에서 확인한 정보입니다."
  ],
  "delayedNote": [
    "The planned release time has passed. We're checking the game's readiness.",
    "공개 목표 시각이 지났습니다. 준비 상태를 확인하고 있어요."
  ],
  "releaseNote": [
    "All times are KST. Release follows development and verification.",
    "한국시간 기준 · 제작과 검증을 마친 뒤 공개합니다."
  ],
  "collectionEnded": [
    "Submissions have ended",
    "제안 접수가 종료되었습니다"
  ],
  "collectionMaintenance": [
    "Under maintenance · Submissions paused",
    "점검 중 · 제안 접수 일시정지"
  ],
  "collectionPaused": [
    "Submissions paused",
    "제안 접수 일시정지"
  ],
  "collectionNext": [
    "Now collecting ideas for the next round",
    "다음 회차 제안을 모집하고 있어요"
  ],
  "collectionOpen": [
    "The first round is open. Share your idea.",
    "지금, 첫 제안을 모집하고 있어요"
  ],
  "collectionPreparing": [
    "Getting ready to accept ideas",
    "제안 모집을 준비하고 있어요"
  ],
  "deadlinePaused": [
    "New ideas and edits are paused. Drafts and past submissions are preserved.",
    "새 제안·수정 접수 중단 · 작성한 내용과 기존 접수 내역은 보존됩니다"
  ],
  "deadlineNext": [
    "Round one is closed. New submissions go into the next round.",
    "첫 회차 모집 마감 · 지금 보낸 제안은 다음 회차에 접수됩니다"
  ],
  "sessionUnavailable": [
    "Couldn't verify the login connection. Please reconnect.",
    "로그인 연결 정보를 확인하지 못했어요. 다시 연결해 주세요."
  ],
  "collectionUnavailable": [
    "Couldn't check submission status. Please reconnect.",
    "모집 상태를 확인하지 못했어요. 다시 연결해 주세요."
  ],
  "operationsUnavailable": [
    "Couldn't check the service status. Your draft is saved.",
    "운영 상태를 확인하지 못했어요. 작성한 내용은 보관됩니다."
  ],
  "intakeResumed": [
    "Submissions are open again. Review your draft, then press Send. It won't be sent automatically.",
    "제안 접수가 재개됐어요. 작성한 내용을 확인한 뒤 전송 버튼을 눌러주세요. 자동 전송하지 않습니다."
  ],
  "quotaUnavailable": [
    "Couldn't check your remaining slots. Please reconnect.",
    "남은 제출 횟수를 확인하지 못했어요. 다시 연결해 주세요."
  ],
  "safetyPendingLabel": [
    "Safety review pending",
    "안전 검토 대기"
  ],
  "safetyPendingMessage": [
    "This idea won't be used for development until it has been reviewed.",
    "운영자가 검토하기 전에는 개발 입력으로 사용하지 않아요."
  ],
  "safetyApprovedLabel": [
    "Safety approved",
    "안전 승인"
  ],
  "safetyApprovedMessage": [
    "This version passed safety review. Inclusion in the game or a release is not guaranteed.",
    "안전 검토를 통과했어요. 게임 반영·공개가 확정된 것은 아니에요."
  ],
  "safetyHeldLabel": [
    "Safety review on hold",
    "안전 검토 보류"
  ],
  "safetyHeldMessage": [
    "Development use is on hold while this idea is checked further.",
    "추가 확인이 필요해 개발 입력을 보류하고 있어요."
  ],
  "safetyBlockedLabel": [
    "Blocked by safety review",
    "안전 기준 차단"
  ],
  "safetyBlockedMessage": [
    "This idea has been excluded from development under the safety guidelines.",
    "안전 기준에 따라 개발 입력에서 제외됐어요."
  ],
  "safetyUnknownLabel": [
    "Safety status unconfirmed",
    "안전 상태 확인 필요"
  ],
  "safetyUnknownMessage": [
    "This idea won't be used for development until safety approval is confirmed.",
    "안전 승인 여부를 확인하기 전에는 개발 입력으로 사용하지 않아요."
  ],
  "noProposals": [
    "No submissions yet. Share your first idea.",
    "아직 보낸 제안이 없어요. 첫 아이디어를 남겨주세요."
  ],
  "editPaused": [
    "Saving paused",
    "저장 일시정지"
  ],
  "editable": [
    "Editable",
    "수정 가능"
  ],
  "editClosed": [
    "Editing closed",
    "수정 마감"
  ],
  "edit": [
    "Edit ↗",
    "수정 ↗"
  ],
  "editAria": [
    "Edit the idea submitted on {date}",
    "{date}에 보낸 제안 수정"
  ],
  "editReReview": [
    " Edits made before the deadline will be reviewed again.",
    " 마감 전 내용을 수정하면 다시 검토합니다."
  ],
  "ownerUnavailable": [
    "Couldn't verify the account for these submissions. Please reconnect.",
    "제출 기록의 계정을 확인하지 못했어요. 연결을 다시 확인해 주세요."
  ],
  "otherTabAccount": [
    "Your login changed in another tab. Please reconnect.",
    "다른 창에서 로그인 상태가 바뀌었어요. 연결을 다시 확인해 주세요."
  ],
  "recheckAccount": [
    "Couldn't verify the signed-in account. Your draft is saved and won't be sent automatically.",
    "로그인 계정을 다시 확인하지 못했어요. 입력한 내용은 보관되며 자동 전송하지 않습니다."
  ],
  "accountChanged": [
    "Your login has changed. Please log in again.",
    "로그인 상태가 바뀌었어요. 다시 로그인해 주세요."
  ],
  "proposalsUnavailable": [
    "Couldn't load your submissions. Please reconnect.",
    "내 제안 목록을 확인하지 못했어요. 다시 연결해 주세요."
  ],
  "editRoundClosed": [
    "This round has closed, so this idea can no longer be edited. You can use your draft as a new submission.",
    "이 제안은 모집이 마감되어 더 이상 수정할 수 없어요. 작성 중인 내용은 새 제안으로 가져올 수 있습니다."
  ],
  "editChangedSaved": [
    "This idea was edited in another tab. Load the latest version before editing again. Your draft is unchanged.",
    "다른 창에서 이 제안이 수정됐어요. 최신 내용을 확인한 뒤 다시 수정해 주세요. 작성 중인 내용은 그대로 남아 있어요."
  ],
  "quotaReturned": [
    "A submission slot is available again. Review your text, then press Send.",
    "제출 횟수가 돌아왔어요. 내용을 확인한 뒤 전송 버튼을 눌러주세요."
  ],
  "recordsUnavailable": [
    "Couldn't check your submissions. Your text is unchanged; please reconnect.",
    "제출 기록을 확인하지 못했어요. 입력한 내용은 그대로 두고 연결을 다시 확인해 주세요."
  ],
  "connectionUnavailable": [
    "Couldn't check the server connection. Your draft is saved.",
    "서버 연결을 확인하지 못했어요. 작성한 내용은 보관됩니다."
  ],
  "editClosedDraft": [
    "This round has closed and editing is no longer available. You can use your draft as a new idea.",
    "이 제안은 모집이 마감되어 수정할 수 없어요. 작성 중인 내용은 새 제안으로 가져올 수 있습니다."
  ],
  "editChanged": [
    "This idea was edited in another tab. Load the latest version before editing again.",
    "다른 창에서 이 제안이 수정됐어요. 최신 내용을 확인한 뒤 다시 수정해 주세요."
  ],
  "editFree": [
    "Saving an edit doesn't use a new submission slot.",
    "수정 내용을 저장해도 새 제안 횟수는 차감되지 않아요."
  ],
  "emptyBody": [
    "Tell us what you'd like in the game, even in one sentence.",
    "어떤 게임을 만들고 싶은지 한 문장을 남겨주세요."
  ],
  "bodyTooLarge": [
    "Ideas can be up to 2,000 UTF-8 bytes. Please shorten your text.",
    "제안은 UTF-8 기준 2,000바이트까지 보낼 수 있어요. 내용을 조금 줄여주세요."
  ],
  "notOpen": [
    "Submissions aren't available right now. Keep your draft and check the submission status again.",
    "지금은 제안을 접수할 수 없어요. 작성한 내용을 보관하고 모집 상태를 다시 확인해 주세요."
  ],
  "resultUnknown": [
    "Couldn't confirm the submission result. Your text is unchanged.",
    "접수 결과를 확인하지 못했어요. 작성한 내용은 그대로 남아 있습니다."
  ],
  "editSaved": [
    "Your edit was saved without using a new slot. Current status: {status}.",
    "수정 내용을 저장했어요. 새 제안 횟수는 차감되지 않았어요. 현재 상태: {status}."
  ],
  "submitted": [
    "Idea submitted. One slot was used. Current status: {status}. You can edit it below until the round closes.",
    "제안이 접수됐어요. 제출 횟수 1회를 사용했으며 현재 상태는 {status}입니다. 모집 마감 전에는 아래에서 수정할 수 있어요."
  ],
  "retrySeconds": [
    "in {seconds} seconds",
    "{seconds}초 후"
  ],
  "retrySoon": [
    "shortly",
    "잠시 후"
  ],
  "rejectedEditPrefix": [
    "Your edit wasn't saved.",
    "수정본을 저장하지 않았어요."
  ],
  "rejectedNewPrefix": [
    "Your idea wasn't submitted.",
    "제안을 접수하지 않았어요."
  ],
  "safetyRejected": [
    "{result} We can't accept requests outside the safety guidelines. Remove explicit sexual or excessive violent content, personal information, or instructions to bypass safety rules. Your draft is saved and no submission slot was used.",
    "{result} 안전 기준을 벗어난 요청은 받을 수 없어요. 과도한 선정성·폭력, 개인정보 또는 안전 규칙을 무력화하는 지시를 제외해 주세요. 작성한 내용은 보관되며 제출 횟수는 차감되지 않았어요."
  ],
  "editRateLimited": [
    "Edits are arriving too quickly. Try saving again {wait}. Your draft and submission slots are unchanged.",
    "너무 빠르게 연속 수정했어요. {wait} 다시 저장해 주세요. 작성한 내용과 제출 횟수는 그대로입니다."
  ],
  "attemptRateLimited": [
    "Too many requests in a short time. Try again {wait}. Your draft and submission slots are unchanged.",
    "요청이 짧은 시간에 너무 많았어요. {wait} 다시 시도해 주세요. 작성한 내용과 제출 횟수는 그대로입니다."
  ],
  "sendUnknown": [
    "Couldn't confirm the result. Your draft is saved. Retrying this same request will not create a duplicate submission.",
    "접수 결과를 확인하지 못했어요. 작성한 내용은 보관됩니다. 다시 전송해도 같은 요청이 중복 접수되지 않아요."
  ],
  "loginExpired": [
    "Please check your login. Your draft is saved. Log in, then press Send again.",
    "로그인 상태를 다시 확인해 주세요. 작성한 내용은 보관됩니다. 로그인한 뒤 다시 전송해 주세요."
  ],
  "autoSendNotReady": [
    "Review your draft and the submission status, then press Send again. Nothing was sent automatically.",
    "작성 내용과 접수 상태를 확인한 뒤 전송 버튼을 다시 눌러주세요. 자동 제출하지 않았어요."
  ],
  "autoSendChanged": [
    "Your text changed, so nothing was sent automatically. Review it, then press Send.",
    "작성한 내용이 달라져 자동 제출하지 않았어요. 내용을 확인한 뒤 전송해 주세요."
  ],
  "autoSendNoQuotaInfo": [
    "Couldn't check your remaining slots, so nothing was sent automatically. Review your draft, then try again.",
    "남은 횟수를 확인하지 못해 자동 제출하지 않았어요. 작성한 내용을 확인한 뒤 다시 전송해 주세요."
  ],
  "nextSlotTime": [
    "at {time} KST",
    "{time} KST부터"
  ],
  "nextSlotAvailable": [
    "when a slot is available",
    "횟수가 돌아오면"
  ],
  "autoSendNoQuota": [
    "No slots left, so nothing was sent automatically. Try again {when}. Your draft is unchanged.",
    "남은 횟수가 없어 자동 제출하지 않았어요. {when} 다시 전송해 주세요. 작성한 내용은 그대로 남아 있어요."
  ],
  "googleTimeout": [
    "Couldn't connect to Google login. Check your network or content-blocking settings, then try again.",
    "Google 로그인에 연결하지 못했어요. 네트워크 또는 콘텐츠 차단 설정을 확인하고 다시 시도해 주세요."
  ],
  "googleUnavailable": [
    "Couldn't prepare Google login. Please try again.",
    "Google 로그인 화면을 준비하지 못했어요. 다시 시도해 주세요."
  ],
  "googleConnection": [
    "Couldn't connect to Google login. Check your network or content-blocking settings.",
    "Google 로그인에 연결하지 못했어요. 네트워크 또는 콘텐츠 차단 설정을 확인해 주세요."
  ],
  "autoSendUnprepared": [
    "Couldn't confirm submission readiness, so nothing was sent automatically. Your draft is saved. Reconnect, then try again.",
    "접수 상태를 확인하지 못해 자동 제출하지 않았어요. 작성한 내용은 보관됩니다. 연결을 확인한 뒤 다시 전송해 주세요."
  ],
  "googleConfig": [
    "Couldn't verify Google login settings. Your draft is saved. Please reconnect shortly.",
    "Google 로그인 설정을 확인하지 못했어요. 입력한 내용은 보관됩니다. 잠시 후 다시 연결해 주세요."
  ],
  "googleAdminPrompt": [
    "Complete Google login with your administrator account.",
    "관리자 계정으로 Google 로그인을 완료해 주세요."
  ],
  "googlePrompt": [
    "Use the Google button to log in.",
    "Google 버튼을 눌러 로그인해 주세요."
  ],
  "adminLoginTitle": [
    "Administrator login",
    "관리자 로그인"
  ],
  "adminLoginDescription": [
    "We'll verify your administrator account again.\nComplete Google login to open the admin area.",
    "관리자 계정을 다시 확인합니다.\nGoogle 로그인을 완료하면 관리자 화면으로 이동해요."
  ],
  "adminLoginNote": [
    "Idea and edit drafts stay in this browser. Administrator login will not submit an idea.",
    "제안과 수정 초안은 이 브라우저에 보관합니다. 관리자 로그인으로 제안이 전송되지는 않아요."
  ],
  "submissionLoginNote": [
    "Your draft is saved. After login, this idea will be submitted if you have a slot available.",
    "작성한 내용은 보관됩니다. 로그인 후 남은 횟수가 있으면 이 제안을 바로 접수해요."
  ],
  "headerLoginNote": [
    "Your draft stays in this browser. Logging in alone will not submit it.",
    "작성한 내용은 이 브라우저에 보관됩니다. 로그인만으로 제안이 전송되지는 않아요."
  ],
  "googleIncomplete": [
    "Login wasn't completed. Use the Google button to try again.",
    "로그인을 완료하지 못했어요. Google 버튼을 눌러 다시 시도해 주세요."
  ],
  "checkingAdmin": [
    "Verifying your Google account and administrator access.",
    "Google 계정과 관리자 권한을 확인하고 있어요."
  ],
  "checkingLoginQuota": [
    "Verifying your Google account and remaining submission slots.",
    "Google 계정과 남은 제출 횟수를 확인하고 있어요."
  ],
  "loginUnavailable": [
    "Couldn't confirm your login. Please try again.",
    "로그인 상태를 확인하지 못했어요. 다시 시도해 주세요."
  ],
  "adminDenied": [
    "This account doesn't have administrator access. No idea was submitted, and your draft is saved.",
    "로그인한 계정에는 관리자 권한이 없어요. 제안은 전송하지 않았으며 작성한 내용은 보관됩니다."
  ],
  "loggedInPaused": [
    "You're logged in. {notice}",
    "로그인했어요. {notice}"
  ],
  "loggedIn": [
    "You're logged in. Share an idea.",
    "로그인했어요. 아이디어를 남겨주세요."
  ],
  "loginPreparationFailed": [
    "You're logged in, but submission setup didn't finish. Your draft is saved. Reconnect, then press Send.",
    "로그인했지만 제출 준비를 마치지 못했어요. 작성한 내용은 보관됩니다. 연결을 다시 확인한 뒤 전송해 주세요."
  ],
  "loggedOut": [
    "You're logged out. Your unsent new idea stays in this browser.",
    "로그아웃했어요. 작성 중이던 새 제안은 이 브라우저에 남아 있어요."
  ],
  "logoutFailed": [
    "Couldn't confirm logout. Check your connection, then try again.",
    "로그아웃을 확인하지 못했어요. 연결을 확인한 뒤 다시 눌러주세요."
  ],
  "logoutReconnect": [
    "You're logged out. Check the server connection before logging in again.",
    "로그아웃했어요. 다시 로그인하려면 서버 연결을 확인해 주세요."
  ],
  "connectionFirst": [
    "Check the server and login connection first. Your text is unchanged.",
    "서버와 로그인 연결을 먼저 확인해 주세요. 작성한 내용은 그대로 남아 있어요."
  ],
  "notAccepting": [
    "Submissions aren't available right now. Your draft is saved and won't be sent automatically.",
    "지금은 제안을 접수할 수 없어요. 작성한 내용은 보관되며 자동 전송하지 않습니다."
  ],
  "noQuota": [
    "You don't have a submission slot right now. Press Send again after the time shown.",
    "지금은 제안을 보낼 수 있는 횟수가 없어요. 표시된 시각 이후에 전송 버튼을 다시 눌러주세요."
  ],
  "editCancelled": [
    "Back to your new idea. Your edit draft stays in this browser.",
    "새 제안 작성으로 돌아왔어요. 수정 중인 내용은 이 브라우저에 보관됩니다."
  ],
  "editCopied": [
    "Ready as a new idea. Sending it will use one submission slot.",
    "새 제안으로 준비했어요. 전송하면 제출 횟수 1회를 사용합니다."
  ],
  "offline": [
    "You're offline. Your draft is saved and won't be sent automatically when the connection returns.",
    "인터넷 연결이 끊겼어요. 작성한 내용은 보관되며, 연결이 돌아와도 자동 전송하지 않습니다."
  ],
  "previewEyebrow": [
    "THE GAME SPACE",
    "게임이 들어올 공간"
  ],
  "previewTitle": [
    "Room for the first adventure.",
    "첫 모험을 기다리는 공간."
  ],
  "previewAria": [
    "Empty white game preview. No playable game is available.",
    "빈 흰색 게임 미리보기입니다. 아직 플레이할 게임은 없습니다."
  ],
  "previewAspect": [
    "9 to 16 aspect ratio",
    "가로 9, 세로 16 비율"
  ],
  "previewFallback": [
    "This is a blank preview, not a playable game.",
    "플레이할 수 있는 게임이 아닌 빈 미리보기입니다."
  ],
  "previewBadge": [
    "PREVIEW ONLY · NOT PLAYABLE",
    "미리보기 전용 · 아직 플레이할 수 없어요"
  ],
  "previewNote": [
    "A blank 9:16 canvas marks the future game area. The first game is still being prepared; this is not a game screen or a live build.",
    "향후 게임이 표시될 자리를 흰색 9:16 캔버스로 마련했습니다. 첫 게임을 준비 중이며 실제 게임 화면이나 실행 중인 빌드가 아닙니다."
  ],
  "communityEyebrow": [
    "IDEAS FROM THE COMMUNITY",
    "함께 나누는 아이디어"
  ],
  "communityTitle": [
    "See what others have in mind.",
    "다른 참여자의 생각도 만나보세요."
  ],
  "communityIntro": [
    "Only ideas shared with the author's consent and approved for safety appear here. Public aliases are separate from Google profiles.",
    "작성자가 공개에 동의하고 안전 승인을 받은 제안만 표시합니다. 공개 별명은 Google 프로필과 별개입니다."
  ],
  "feedOrder": [
    "Community feed order",
    "공개 제안 정렬"
  ],
  "recentIdeas": [
    "Recent ideas",
    "최근 의견"
  ],
  "popularIdeas": [
    "Popular ideas",
    "인기 의견"
  ],
  "refreshCommunity": [
    "Refresh",
    "새로고침"
  ],
  "communityLoading": [
    "Loading shared ideas…",
    "공개 제안을 불러오는 중…"
  ],
  "loadMoreIdeas": [
    "Load more ideas",
    "의견 더 보기"
  ],
  "leaderboardEyebrow": [
    "CONTRIBUTIONS THAT MADE IT IN",
    "실제로 반영된 기여"
  ],
  "leaderboardTitle": [
    "Contribution board",
    "기여도 리더보드"
  ],
  "leaderboardNote": [
    "Points reflect verified contributions to released game versions. No test scores or sample players are shown.",
    "실제 공개된 게임에 검증된 기여를 점수로 기록합니다. 테스트 점수나 가상의 참여자를 표시하지 않습니다."
  ],
  "leaderboardLoading": [
    "Loading contributions…",
    "기여도를 불러오는 중…"
  ],
  "retryCommunityAction": [
    "Check the same request again",
    "같은 요청 결과 다시 확인"
  ],
  "publicationEyebrow": [
    "YOUR CHOICE TO SHARE",
    "공개 여부는 직접 선택"
  ],
  "closePublication": [
    "Close sharing dialog",
    "공개 설정 창 닫기"
  ],
  "publicationSourceLabel": [
    "THE EXACT TEXT YOU WILL SHARE",
    "공개할 원문 그대로 확인"
  ],
  "cancelSharing": [
    "Cancel",
    "취소"
  ],
  "communityEmpty": [
    "No ideas have been shared and safety-approved yet. Your submissions remain private unless you choose to share them.",
    "아직 공개 동의와 안전 승인을 모두 받은 제안이 없습니다. 직접 공개를 선택하지 않은 제안은 비공개로 유지됩니다."
  ],
  "leaderboardEmpty": [
    "No verified contribution scores are listed yet. Only participants who opt in will appear.",
    "아직 표시할 검증된 기여도 기록이 없습니다. 리더보드는 공개에 동의한 참여자만 표시합니다."
  ],
  "communityUnavailable": [
    "Couldn't load the community. You can still write or edit your own ideas. Try Refresh shortly.",
    "커뮤니티를 불러오지 못했습니다. 내 제안 작성과 수정은 계속 이용할 수 있어요. 잠시 후 새로고침해 주세요."
  ],
  "communityInvalid": [
    "The community response couldn't be verified. No unverified ideas or scores are displayed.",
    "커뮤니티 응답을 확인하지 못했습니다. 확인되지 않은 제안이나 점수는 표시하지 않습니다."
  ],
  "communityPrivateUnavailable": [
    "Couldn't check your sharing and voting settings. Your idea draft is unchanged. Refresh the community before making changes.",
    "공개·투표 설정을 확인하지 못했습니다. 작성 중인 초안은 그대로입니다. 변경하려면 커뮤니티를 다시 불러와 주세요."
  ],
  "communityAccountChanged": [
    "Your account changed. Sharing and voting were not repeated. Check your account and try again.",
    "로그인 계정이 바뀌었습니다. 공개 설정이나 투표를 다시 실행하지 않았어요. 계정을 확인한 뒤 다시 시도해 주세요."
  ],
  "voteQuota": [
    "{remaining} / {limit} votes available this round",
    "이번 회차 남은 투표 {remaining} / {limit}"
  ],
  "voteQuotaNote": [
    "Up and down votes share this allowance. Changing or removing a vote does not submit a new idea.",
    "찬성·반대는 같은 투표권을 사용합니다. 표 변경·취소는 새 제안 접수와 별개입니다."
  ],
  "voteLoginNote": [
    "Log in to vote. You will need to choose your vote again after login.",
    "투표하려면 로그인해 주세요. 로그인 후 원하는 표를 다시 눌러 확인합니다."
  ],
  "voteSettingsLoading": [
    "Checking your votes…",
    "내 투표 확인 중…"
  ],
  "votingWaiting": [
    "Voting is not open for a round yet.",
    "아직 투표할 수 있는 회차가 열리지 않았습니다."
  ],
  "votingClosed": [
    "Voting closed",
    "투표 마감"
  ],
  "yourIdea": [
    "Your idea",
    "내 제안"
  ],
  "upvote": [
    "Upvote",
    "찬성"
  ],
  "downvote": [
    "Downvote",
    "반대"
  ],
  "removeUpvote": [
    "Remove upvote",
    "찬성 취소"
  ],
  "removeDownvote": [
    "Remove downvote",
    "반대 취소"
  ],
  "voteCountAria": [
    "{action}: {count} votes",
    "{action}: {count}표"
  ],
  "voteChanged": [
    "This idea or its publication changed. Refresh and read the current text before voting.",
    "제안 원문이나 공개 상태가 바뀌었습니다. 새로고침한 뒤 현재 내용을 읽고 투표해 주세요."
  ],
  "voteRecorded": [
    "Your vote was recorded. Voting does not award contribution points immediately.",
    "투표를 기록했습니다. 투표만으로 기여도가 즉시 지급되지는 않습니다."
  ],
  "voteRemoved": [
    "Your vote was removed.",
    "투표를 취소했습니다."
  ],
  "communityLoginTitle": [
    "Log in to join the discussion.",
    "투표로 의견을 더해주세요."
  ],
  "communityLoginDescription": [
    "Use your Google account to vote on shared ideas.\nAfter login, read the current text and choose your vote again.",
    "Google 계정으로 로그인하고 공개 제안에 투표해 주세요.\n로그인 후 현재 원문을 확인하고 원하는 표를 다시 눌러주세요."
  ],
  "communityLoginNote": [
    "Login won't cast a vote or send your draft. Both require your explicit action.",
    "로그인만으로 표를 던지거나 초안을 전송하지 않습니다. 각각 직접 선택해야 합니다."
  ],
  "communityLoginDone": [
    "You're logged in. Review the current idea and choose a vote. Nothing was voted on or submitted automatically.",
    "로그인했습니다. 현재 제안 내용을 확인하고 원하는 표를 눌러주세요. 자동 투표나 제안 전송은 하지 않았습니다."
  ],
  "communityLoginChecking": [
    "Verifying your Google account. No vote will be cast automatically.",
    "Google 계정을 확인하고 있어요. 자동으로 투표하지 않습니다."
  ],
  "communityLoginPreparationFailed": [
    "You're logged in, but participation details couldn't be loaded. Your draft is kept and no vote was cast. Refresh the community before choosing your vote again.",
    "로그인은 완료했지만 참여 정보를 불러오지 못했습니다. 초안을 보관했고 투표하지 않았습니다. 커뮤니티를 새로고침한 뒤 원하는 표를 다시 눌러 주세요."
  ],
  "sharingPrivate": [
    "Private",
    "비공개"
  ],
  "sharingPublic": [
    "Shared publicly",
    "공개 중"
  ],
  "sharingPending": [
    "Sharing requested · awaiting publication checks",
    "공개 동의 완료 · 공개 요건 확인 대기"
  ],
  "sharingChanged": [
    "Edited text needs new sharing consent",
    "수정된 원문은 새 공개 동의가 필요합니다"
  ],
  "shareIdea": [
    "Share after safety review",
    "안전 심사 후 공개"
  ],
  "hideIdea": [
    "Make private",
    "비공개로 전환"
  ],
  "sharingLoading": [
    "Checking sharing settings",
    "공개 설정 확인 중"
  ],
  "shareTitle": [
    "Share this exact idea?",
    "이 원문을 공개할까요?"
  ],
  "shareDescription": [
    "The text below can appear publicly under your generated alias after safety approval. Your Google name and email will not be shared. Editing the idea requires fresh consent; previous votes won't carry over.",
    "아래 원문은 안전 승인 후 공개 별명으로 표시될 수 있습니다. Google 이름과 이메일은 공개하지 않습니다. 원문을 수정하면 다시 동의해야 하며 이전 표는 이어지지 않습니다."
  ],
  "hideTitle": [
    "Make this idea private?",
    "이 제안을 비공개로 전환할까요?"
  ],
  "hideDescription": [
    "The idea will leave public feeds and stop accepting votes. Your original submission and private history are kept. This cannot recall copies other people already made.",
    "공개 목록에서 제외하고 새 투표를 받지 않습니다. 접수 원문과 본인의 기록은 보존합니다. 다른 사람이 이미 복사한 내용까지 회수할 수는 없습니다."
  ],
  "aliasPreview": [
    "Public alias: {alias}",
    "공개 별명: {alias}"
  ],
  "shareConsent": [
    "I agree to share this exact text under this alias after safety approval. Safety approval does not guarantee that it will be included in the game.",
    "이 원문을 위 별명으로 안전 승인 후 공개하는 데 동의합니다. 안전 승인이 게임 반영을 보장하지는 않습니다."
  ],
  "confirmShare": [
    "Agree and request sharing",
    "동의하고 공개 요청"
  ],
  "confirmHide": [
    "Make private",
    "비공개로 전환"
  ],
  "shareSaved": [
    "Your sharing choice was saved. This exact text will appear only while its safety approval and other eligibility checks remain valid.",
    "공개 선택을 저장했습니다. 이 원문에 대한 안전 승인과 공개 조건이 유효할 때만 표시합니다."
  ],
  "hideSaved": [
    "This idea is now private. Your original submission is preserved.",
    "제안을 비공개로 전환했습니다. 접수 원문은 보존됩니다."
  ],
  "publicationStale": [
    "The text or sharing settings changed while this dialog was open. Close it and review the latest version before confirming.",
    "창을 연 뒤 원문이나 공개 설정이 바뀌었습니다. 창을 닫고 최신 내용을 다시 확인한 후 선택해 주세요."
  ],
  "publicationNotReady": [
    "Sharing settings aren't ready. Refresh the community and try again. Nothing has been shared.",
    "공개 설정을 확인하지 못했습니다. 커뮤니티를 새로고침한 뒤 다시 시도해 주세요. 공개하지 않았습니다."
  ],
  "yourContribution": [
    "Your contribution: {points} points · {count} verified adoptions",
    "내 기여도: {points}점 · 검증된 반영 {count}건"
  ],
  "showLeaderboard": [
    "Join the public board",
    "리더보드 공개하기"
  ],
  "hideLeaderboard": [
    "Leave the public board",
    "리더보드 비공개로"
  ],
  "boardShareTitle": [
    "Show your contribution score?",
    "내 기여도를 공개할까요?"
  ],
  "boardShareDescription": [
    "Only your generated alias, verified points, and adoption count will appear on the public board. Your Google name, email, and private ideas stay private.",
    "공개 별명과 검증된 기여도·반영 건수만 리더보드에 표시합니다. Google 이름·이메일과 비공개 제안은 공개하지 않습니다."
  ],
  "boardConsent": [
    "I agree to show this alias and my verified contribution record on the public leaderboard.",
    "위 별명과 검증된 기여 기록을 공개 리더보드에 표시하는 데 동의합니다."
  ],
  "boardHideTitle": [
    "Hide your contribution score?",
    "내 기여도를 비공개로 전환할까요?"
  ],
  "boardHideDescription": [
    "You will leave the public board. Your points and private contribution record are preserved.",
    "공개 리더보드에서 제외합니다. 내 점수와 개인 기여 기록은 보존합니다."
  ],
  "boardConfirmShow": [
    "Agree and join",
    "동의하고 공개"
  ],
  "boardConfirmHide": [
    "Make private",
    "비공개로 전환"
  ],
  "boardVisibleSaved": [
    "Your leaderboard visibility was updated. Only your public alias and verified record can appear.",
    "리더보드 공개 설정을 변경했습니다. 공개 별명과 검증된 기여 기록만 표시할 수 있습니다."
  ],
  "communitySaving": [
    "Saving your choice…",
    "선택을 저장하는 중…"
  ],
  "communityUnknown": [
    "Couldn't confirm whether the change was saved. Don't start another change yet. Use “Check the same request again” to retry safely without creating a duplicate.",
    "변경이 저장됐는지 확인하지 못했습니다. 다른 변경은 잠시 멈추고 ‘같은 요청 결과 다시 확인’을 눌러 중복 없이 확인해 주세요."
  ],
  "communityRetryFirst": [
    "A previous change still needs confirmation. Check that same request before starting another change.",
    "이전 변경 결과를 확인해야 합니다. 다른 작업 전에 같은 요청 결과를 다시 확인해 주세요."
  ],
  "communityRetryThrottled": [
    "Too many requests to confirm the earlier result right now. The original request is kept. Wait a little, then use “Check the same request again”. No new change will be sent automatically.",
    "요청이 너무 잦아 이전 결과를 아직 확인하지 못했습니다. 원래 요청은 보관 중입니다. 잠시 후 ‘같은 요청 결과 다시 확인’을 눌러 주세요. 자동으로 다시 보내지 않습니다."
  ],
  "communityResultInvalid": [
    "Couldn't verify the result of this change. Check the same request again.",
    "변경 결과를 확인하지 못했습니다. 같은 요청 결과를 다시 확인해 주세요."
  ],
  "pointsAria": [
    "{points} contribution points",
    "기여도 {points}점"
  ],
  "scoringPending": [
    "Scoring rules are still being confirmed. No contribution points are being issued yet.",
    "배점 규칙을 확인 중입니다. 아직 기여도를 발행하지 않습니다."
  ],
  "scoringClosed": [
    "Contribution points are issued only after a verified game release. Safety approval or casting a vote alone does not earn points.",
    "기여도는 검증된 게임 공개 후에만 발행합니다. 안전 승인이나 투표만으로 점수를 받지는 않습니다."
  ],
  "scoringProposer": [
    "Idea contribution: {formula}",
    "제안 기여도: {formula}"
  ],
  "scoringVoter": [
    "Vote contribution: {formula}",
    "투표 기여도: {formula}"
  ],
  "formulaUp": [
    "upvotes",
    "찬성표"
  ],
  "formulaDown": [
    "downvotes",
    "반대표"
  ],
  "formulaPower": [
    "{term}^{value}",
    "{term}^{value}"
  ],
  "formulaMultiply": [
    "{term} × {value}",
    "{term} × {value}"
  ]
};

i18n.register('public', {
  en: Object.fromEntries(Object.entries(copy).map(([key, text]) => [key, text[0]])),
  ko: Object.fromEntries(Object.entries(copy).map(([key, text]) => [key, text[1]])),
});
