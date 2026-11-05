# NTE Scrapper 2

URL을 입력하고 **확인**을 누르면 회차별 TXT를 저장하고, 전체 저장이 끝난 뒤 통합 TXT와 EPUB을 만드는 Windows 프로그램입니다. AI 서비스나 API 키가 필요하지 않습니다.

## 다운로드

[최신 Windows EXE 다운로드](https://github.com/siholee/NTE-Scrapper/releases/latest)

Releases에서 EXE를 다운로드해 실행하고 작품 목록 URL을 입력하세요. 설치형 EXE이며 별도의 Node.js 설치는 필요하지 않습니다. Chrome 또는 Edge는 설치되어 있어야 합니다.

지원 주소는 Bookkor(`*.bookkor.com/작품명`)와 `/novel/작품번호` 형식입니다. 모든 웹사이트를 지원하는 범용 스크래퍼는 아닙니다.

회차·목록 페이지·재시도 요청은 **최소 7초 간격**으로 실행합니다. MCP로 짧은 간격을 요청해도 7초보다 짧게 동작하지 않습니다. 본문 로딩에 시간이 걸리면 실제 간격은 더 길어질 수 있습니다.

진행률·중단·이어받기를 지원합니다. 정상 저장된 TXT는 체크섬 확인 후 재사용합니다. 창을 닫아도 백그라운드 작업은 계속되며 **중단** 버튼으로 멈춥니다. 다시 실행하면 최근 작업을 확인할 수 있습니다. 인증이 필요하면 열린 브라우저에서 직접 처리하고 **이어받기 / 계속**을 누르세요. 사이트가 HTTP 403을 반환하면 반복 요청을 중단합니다.

결과 위치는 **저장 폴더 열기** 버튼으로 확인하세요. 기본값은 앱 사용자 데이터 폴더의 `data/library`입니다. `NTE_DATA_DIR` 환경변수로 경로를 지정할 수 있습니다. 기존 Node MCP와 데이터를 공유하려면 같은 경로를 지정하세요.

## MCP

설치 폴더의 `NTE-MCP.cmd`를 MCP 클라이언트의 실행 명령으로 지정하면 창 없이 stdio MCP 서버로 동작합니다. 별도 Node.js 설치는 필요 없습니다. GUI에는 AI가 필요하지 않으며 MCP는 선택 사항입니다.

```json
{"mcpServers":{"nte-scrapper":{"command":"C:\\Tools\\NTE Scrapper\\NTE-MCP.cmd","args":[]}}}
```

기존 Node 설정(`node src/server.js`)도 유지됩니다. `nte_start`, `nte_status`, `nte_continue`, `nte_cancel`, `nte_inspect`, `nte_library`, `nte_export`, `nte_diagnose`, `nte_health`를 제공합니다.

## 개발과 배포

```powershell
npm ci
npm start               # GUI
npm run start:mcp       # stdio MCP
npm test
npm run build:win       # dist의 Windows x64 설치 EXE
```

Windows에서 빌드합니다. `v*` 태그를 올리면 GitHub Actions가 테스트·EXE 빌드 후 공개 Release에 첨부합니다. 수집한 소설·브라우저 프로필·로그인 정보·개인 작업 기록은 공개 소스와 EXE에 포함하지 않습니다.

라이선스: MIT. 배포 EXE는 코드 서명되지 않았습니다.
