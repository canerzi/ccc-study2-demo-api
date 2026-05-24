
CCC Study 2 Demo API — local run steps

Your target folder on your Mac:
'/Users/canerzi/Desktop/Complementary Papers/03_Vignette_FreshStudy/Mockup/ccc_study2_demo_api'

This package contains:
- server.js
- package.json
- .env.example
- public/index.html
- data/qa_library.json

Run:
1) cd "/Users/canerzi/Desktop/Complementary Papers/03_Vignette_FreshStudy/Mockup/ccc_study2_demo_api"
2) npm install
3) cp .env.example .env
4) Open .env and paste your OpenAI key:
   OPENAI_API_KEY=sk-proj-your_actual_key_here
   OPENAI_MODEL=gpt-4o
   PORT=3000
5) npm start
6) Open http://localhost:3000/?arm=tca

Test:
- "Should I buy water or donate cash?"
- "What is most needed?"
- "Where does the money go?"
- "How long will delivery take?"
