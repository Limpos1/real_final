#!/bin/bash
# Windows용 start-dev.bat 을 macOS용으로 옮긴 스크립트
# 실행 방법: chmod +x start-dev.sh 후 ./start-dev.sh

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# AppleScript 문자열 안에 안전하게 넣기 위해 백슬래시/따옴표를 이스케이프
escape_for_applescript() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

run_in_new_window() {
  local title="$1"
  local cmd="$2"
  local full_cmd="echo '=== ${title} ==='; ${cmd}"
  local escaped
  escaped="$(escape_for_applescript "$full_cmd")"

  osascript -e "tell application \"Terminal\"" \
            -e "activate" \
            -e "do script \"${escaped}\"" \
            -e "end tell"
}

# 1) Backend (Python/uvicorn)
# 필요한 파이썬 패키지가 없으면 requirements.txt로 설치한 뒤 실행한다.
run_in_new_window "Planit Backend" "cd '${DIR}'; python3 -c 'import fastapi, uvicorn, multipart, anthropic, google.genai, pdfplumber, fitz, firebase_admin' 2>/dev/null || python3 -m pip install -r requirements.txt; python3 -m uvicorn server:app --reload --host 0.0.0.0"

# 2) Checklist (Gradle)
run_in_new_window "Planit Checklist" "cd '${DIR}/Planit-Web-Checklist-main'; ./gradlew bootRun"

# 3) Auth (Gradle)
run_in_new_window "Planit Auth" "cd '${DIR}/Planit-Web-Auth-Plan-Quiz-master/Planit-Web-Auth-Plan-Quiz-master/backend'; ./gradlew bootRun"

# 4) Frontend (npm)
# node_modules가 없으면(처음 받은 PC) npm install 먼저 실행
run_in_new_window "Planit Frontend" "cd '${DIR}/frontend'; [ -d node_modules ] || npm install; npm run dev"