# Wishlist Bot

간단한 Discord 위시리스트 및 에스크로(이메일 코드 인증) 봇입니다.

설치:

```bash
npm install
cp .env.example .env
# .env에 TOKEN과 SMTP 설정 추가
npm start
```

명령어 요약:
- `/escrow_set email:<email>` : 서버 관리자 전용, 에스크로 이메일 설정
- `/escrow_send` : 본인 계정으로 인증 코드를 발송
- `/escrow_verify code:<code>` : 이메일로 받은 코드로 인증, 성공 시 `거래인증` 역할 부여

신용인 인증 패널 이미지가 필요하면 `.env`에 `ESCROW_PANEL_IMAGE_URL_1`과 `ESCROW_PANEL_IMAGE_URL_2`를 넣으세요.
값은 공개 이미지 URL이거나, `index.js` 기준의 로컬 파일 경로일 수 있습니다.
