# usege-claude

Claude 5시간 사용량을 바탕화면에 표시하는 투명 위젯. 막대 하나와 초기화 시각만 보여준다.

## 실행

`launch.vbs` 더블클릭.

처음에는 "로그인 필요"가 뜬다. 위젯에 **우클릭 → Claude 로그인**을 누르면 claude.ai 로그인
창이 열린다. 평소대로 로그인하면 창이 닫히고 사용량이 표시된다. 이후로는 창이 뜨지 않는다.

## 조작

| 동작 | 기능 |
|------|------|
| 드래그 | 위젯 이동 (위치 기억됨) |
| 더블클릭 | 즉시 새로고침 |
| 우클릭 | 새로고침 / 로그인·로그아웃 / 시작프로그램 / 종료 |

5분마다 자동 갱신한다.

## 표시 내용

- **막대** — 5시간 창 사용률 (`five_hour.utilization`)
- **숫자** — 5시간 창이 초기화되는 시각 (`five_hour.resets_at`)

막대 색은 사용률에 따라 바뀐다.

| 사용률 | 색 |
|---|---|
| 0 ~ 79.9% | 노랑 `#FFDC50` |
| 80 ~ 89.9% | 주황 `#FFA23D` |
| 90% 이상 | 붉은 주황 `#FF6242` |

숫자 자리에는 상황에 따라 다른 글자가 뜬다.

| 표시 | 뜻 |
|---|---|
| `13:30` | 초기화 시각 |
| 사용 없음 | 이번 창에서 쓴 적이 없어 창이 열리지 않음 |
| 로그인 필요 | 세션 없음 또는 만료 |
| 조회 실패 | 응답을 읽지 못함 (우클릭 → 진단 정보 저장) |

## 갱신 주기

한도에 가까울수록 자주 확인한다.

| 사용률 | 다음 조회 |
|---|---|
| 0 ~ 79.9% | 5분 뒤 |
| 80 ~ 89.9% | 3분 뒤 |
| 90 ~ 99.9% | 1분 뒤 |
| 100% | 초기화 시각까지 대기 (최대 30분씩 끊어서) |

## 동작 방식

claude.ai는 Cloudflare 뒤에 있어서 Node의 `fetch`로는 접근할 수 없다. 그래서 모든 요청은
숨긴 Chromium 창(`show: false`)이 URL을 로드하고 본문을 읽는 방식으로 처리한다.

로그인도 같은 이유로 앱 안에 폼을 만들지 않는다. 진짜 `claude.ai/login` 페이지를 창으로 띄우고,
`sessionKey` 쿠키가 생기는 순간을 쿠키 이벤트로 가로챈다. 덕분에 로그인 수단(이메일 코드,
Google, Apple 등)에 전혀 의존하지 않는다.

`sessionKey`는 `safeStorage`(Windows DPAPI)로 암호화해 `%APPDATA%\usege-claude\store.json`에
저장한다. 로그아웃하면 키와 claude.ai 쿠키를 모두 지운다.

사용하는 엔드포인트는 claude.ai 웹앱이 자체적으로 쓰는 내부 경로이며 공식 API가 아니다.
예고 없이 바뀔 수 있다.

```
GET https://claude.ai/api/organizations
GET https://claude.ai/api/organizations/{orgId}/usage
```

## 개발

```bash
npm install
npm start

# 로그인 없이 UI만 확인
set USEGE_CLAUDE_MOCK=1 && npm start
```

## 참고

로그인 처리 방식은 [SlavomirDurej/claude-usage-widget](https://github.com/SlavomirDurej/claude-usage-widget)을
참고했다.
