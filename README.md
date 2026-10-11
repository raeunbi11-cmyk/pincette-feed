# 뉴스 핀셋 (News Pincette)

관심 키워드와 수집 기준에 맞는 최신 기사를 모아 보여주는 큐레이션 화면입니다. 메뉴, 카드, 수집 기준, 품질 관리, 브라우저 `localStorage` 저장은 기존 뉴스 핀셋 화면을 그대로 사용합니다.

즉시 수집은 Gemini에게 기사를 만들어 달라고 하지 않습니다. 서버의 `POST /api/news/collect`가 다음 순서로 실제 기사를 가져옵니다.

1. 키워드마다 Google News RSS와 Bing News RSS를 조회합니다.
2. 선택한 기간 밖의 기사, 블로그·커뮤니티 글, 제외 규칙에 해당하는 기사를 걸러냅니다.
3. Google News 링크는 언론사 원문 주소로 풀고, 제목과 주소가 같은 기사는 한 번만 남깁니다.
4. 원문 HTML에서 본문을 읽어 한 줄 요약과 관련도 점수를 만듭니다.

키워드 추천과 삭제 사유 분석은 기존처럼 설정에 저장한 Gemini API 키를 사용합니다. 기사 수집에는 그 키가 필요 없습니다.

## 실행

```bash
npm install
npm run dev
```

브라우저에서 [http://127.0.0.1:43127](http://127.0.0.1:43127) 을 엽니다.

```bash
npm test
npm run typecheck
```

## 수집 API

`POST /api/news/collect`

```json
{
  "keywords": ["디지털 헬스케어"],
  "fetchRange": 7,
  "role": "헬스케어 서비스 기획자",
  "purpose": "경쟁사 동향 파악",
  "focus": "서비스 출시와 MOU",
  "excludeRules": ["단순 주식 종목 추천"]
}
```

응답의 `articles`는 피드가 그대로 그리는 `id`, `source`, `date`, `title`, `summary`, `score`, `url` 형식입니다. `totalFetched`는 중복을 제거한 후보 수, `passed`는 기준을 통과한 기사 수입니다.
