# Furniture Extractor prototype

이미지에서 이동 가능한 가구를 분류하고 위치를 표시하는 React/Vite 프로토타입입니다.

## 실행

```bash
cp .env.example .env.local
npm install
npm run dev
```

`VITE_FURNITURE_API_URL`은 Gemini 호환 응답을 반환하는 **서버 측 프록시**를 가리켜야 합니다. Vite의 `VITE_*` 값은 브라우저 번들에 포함되므로 Google/Gemini API 키 같은 공급자 자격 증명을 넣으면 안 됩니다.

기본 프록시 경로는 `/api/furniture/analyze`입니다.
