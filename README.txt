JONGRO M ENGLISH ALL IN ONE v2.0 — Galaxy / One UI Edition

실행
1. npm install
2. 환경변수 설정
   OPENAI_API_KEY=...
   DATABASE_URL=...   (권장: PostgreSQL / Neon)
   OPENAI_MODEL=gpt-5.6-luna  (선택)
3. npm start

핵심 변경
- Galaxy One UI 느낌의 카드형 반응형 UI
- EXAM / WEEKLY / VOCA / 출제·성적 이력 유지
- OpenAI Responses API 연결
- 같은 지문 과거 출제 이력을 생성 프롬프트에 자동 전달
- 같은 정답 근거/핵심 추론/선택지 논리/빈칸 위치 반복 금지 규칙
- 생성 결과를 exam_history에 저장하여 다음 출제 때 비교

주의
- OPENAI_API_KEY는 브라우저 코드에 넣지 말고 Render 환경변수에만 등록하세요.
- DATABASE_URL이 없으면 출제 이력은 서버 재시작 시 사라집니다.
