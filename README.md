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

## Google 로그인과 기기 간 동기화

Supabase 설정값이 있으면 우측 상단에 **Google로 로그인** 버튼이 나타납니다. 설정값이 없으면 지금처럼 브라우저 `localStorage`에만 저장합니다.

- 로그인 상태는 브라우저에 유지되어 다음에 열 때 자동으로 로그인됩니다.
- 처음 로그인할 때 계정에 저장된 기록이 없으면, 그 브라우저의 기존 기록을 계정으로 한 번 옮깁니다.
- 계정에 이미 기록이 있으면 계정 기록을 불러오고, 그 브라우저의 기존 기록은 `pincetteState.localBackup`에 백업합니다.
- 기사, 수집 이력, 삭제 기록, 제외 규칙, 키워드, 설정이 바뀔 때마다 계정에 저장되고, 다른 탭이나 기기로 돌아오면 최신 내용을 다시 불러옵니다.
- 오래 열어 둔 다른 기기의 탭이 더 최신 기록을 덮어쓰지 못하도록 저장 시 버전을 확인합니다.
- Gemini API 키는 `STATE_ENCRYPTION_KEY`로 암호화해 계정에 저장합니다. 이 값이 없으면 키는 각 브라우저에만 남습니다.
- 로그아웃하면 그 브라우저에 남은 기록을 지웁니다.

### 설정 순서

1. [Supabase](https://supabase.com)에서 새 프로젝트를 만듭니다.
2. **SQL Editor**에 `supabase/schema.sql`을 붙여 넣고 실행합니다.
3. [Google Cloud Console](https://console.cloud.google.com/apis/credentials)에서 OAuth 클라이언트 ID(웹 애플리케이션)를 만들고, 승인된 리디렉션 URI에 `https://<프로젝트 ref>.supabase.co/auth/v1/callback`을 넣습니다.
4. Supabase **Authentication → Sign In / Providers → Google**을 켜고 3번의 클라이언트 ID와 보안 비밀을 넣습니다.
5. Supabase **Authentication → URL Configuration**에서 Site URL을 `https://pincette-feed.vercel.app`으로, Redirect URLs에 `https://pincette-feed.vercel.app/**`와 `http://127.0.0.1:43127/**`을 넣습니다.
6. Vercel 프로젝트 **Settings → Environment Variables**에 아래 값을 넣고 다시 배포합니다.

| 이름 | 값 |
|------|----|
| `SUPABASE_URL` | Supabase **Project Settings → API**의 Project URL |
| `SUPABASE_ANON_KEY` | 같은 화면의 anon(public) 또는 publishable 키 |
| `STATE_ENCRYPTION_KEY` | 임의의 긴 문자열 (`openssl rand -base64 32`). 바꾸면 저장된 Gemini 키를 다시 입력해야 합니다. |

로컬에서는 같은 값을 `.env.local`에 넣으면 됩니다.

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
