장기 대책: Gmail API(Pub/Sub) 또는 SMS 게이트웨이 전환 가이드

배경
- IMAP/SMTP 폴링 방식은 대량/자동 트래픽에서 취약하며, Gmail과 같은 대형 서비스는 비정상 패턴을 탐지해 차단할 수 있습니다.

옵션 A: Gmail API + Pub/Sub (권장)
1. 장점: 푸시 기반(실시간), 폴링 불필요, 안정적 인증(OAuth), 대량 처리에 안전
2. 개요
   - Google Cloud 프로젝트 생성
   - Gmail API 사용 설정
   - OAuth 2.0 클라이언트 구성(서비스 계정 또는 OAuth consent)
   - Pub/Sub 토픽/구독 생성 및 Gmail push 알림 설정
   - 서버에서 Pub/Sub 구독 메시지를 받고, 메시지의 메시지Id로 메시지 가져오도록 구현
3. 고려사항
   - OAuth 토큰 관리 필요
   - 구현 난이도 ↑ (그러나 안정성·스케일이 대폭 향상)

옵션 B: 상용 SMS 게이트웨이(권장2)
1. 장점: SMS 전송 안정적, 이메일 변환을 사용하지 않음, SLA 제공
2. 통합 방법
   - Twilio, MessageBird, AWS SNS, KakaoBiz 등 업체 이용
   - API 키 발급 후 SMS 전송/수신(수신은 일부 업체에서 제공)
3. 고려사항
   - 비용 발생
   - 일부 국가/통신사 제약

권장 실행 로드맵
1. 단기(지금~2주): IMAP 폴링 완화(이미 적용됨), SMTP 전송 레이트 제한 적용(이미 적용됨)
2. 중기(2~6주): Gmail API PoC 구현 혹은 Twilio 연동 PoC
3. 장기(1~3개월): 완전 전환 및 운영 모니터링, 호스팅 정책 문서화

추가 도움 가능
- PoC 코드 스니펫 제공
- Pub/Sub 수신용 간단 서버 샘플 작성
- Twilio 연동 예제 제공
