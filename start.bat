@echo off
REM start-dev.sh(macOS용)를 Windows용으로 옮긴 스크립트
REM 실행 방법: 이 파일을 더블클릭하거나, cmd/PowerShell에서 start-dev.bat 실행

set "DIR=%~dp0"

REM 1) Backend (Python/uvicorn)
REM --host 0.0.0.0: 안드로이드 실기기(같은 와이파이)에서도 PC IP로 접속할 수 있게 한다.
REM Python 선택: py -3.11 -> py -3 -> python 순서로, PC에 있는 걸 자동으로 쓴다
REM (팀원 PC에 "python" 명령이 없고 "py" 런처만 있는 경우 대응).
set "PY="
py -3.11 --version >nul 2>nul && set "PY=py -3.11"
if not defined PY (py -3 --version >nul 2>nul && set "PY=py -3")
if not defined PY set "PY=python"
REM 필요한 파이썬 패키지가 하나라도 없으면 requirements.txt로 자동 설치한다.
%PY% -c "import fastapi, uvicorn, multipart, anthropic, google.genai, pdfplumber, fitz, firebase_admin" >nul 2>nul
if errorlevel 1 (
  echo [Planit] Installing Python packages...
  %PY% -m pip install -r "%DIR%requirements.txt"
)
start "Planit Backend" cmd /k "cd /d "%DIR%" && %PY% -m uvicorn server:app --reload --host 0.0.0.0"

REM 2) Checklist (Gradle)
start "Planit Checklist" cmd /k "cd /d "%DIR%Planit-Web-Checklist-main" && gradlew.bat bootRun"

REM 3) Auth (Gradle)
start "Planit Auth" cmd /k "cd /d "%DIR%Planit-Web-Auth-Plan-Quiz-master\Planit-Web-Auth-Plan-Quiz-master\backend" && gradlew.bat bootRun"

REM 4) Frontend (npm)
REM node_modules가 없으면(처음 받은 PC) npm install 먼저 실행
start "Planit Frontend" cmd /k "cd /d "%DIR%frontend" && (if not exist node_modules npm install) && npm run dev"
