# -*- coding: utf-8 -*-
"""
챗봇용 Google Gemini API 호출부.

- GEMINI_API_KEY 환경변수가 필요하다. https://aistudio.google.com/apikey 에서
  구글 계정으로 무료로 발급받을 수 있다 (무료 티어라 시연용으로는 비용이 안 든다).
- 목차 파싱(api_call.py)은 Anthropic API를 쓰지만, 챗봇은 완전히 별개 기능이라
  다른 API 키(GEMINI_API_KEY)를 쓴다. 목차 파싱 키가 없어도 챗봇은 동작한다.
- pip install google-genai --break-system-packages
"""
import datetime
import os
import time

from google import genai
from google.genai import errors, types

# 무료 티어로 제공되는 가벼운 모델. 구글이 모델 라인업을 바꾸면
# https://ai.google.dev/gemini-api/docs/pricing 에서 "무료" 표시가 붙은
# 최신 모델 이름으로 바꿔서 GEMINI_MODEL 환경변수로 오버라이드하면 된다.
MODEL_NAME = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")

# 무료 티어는 "This model is currently experiencing high demand"(503) 같은 일시적
# 과부하 응답이 종종 온다. GeminiQuizQuestionGenerator(자바 쪽)와 같은 재시도 정책.
MAX_ATTEMPTS = 5
RETRY_DELAY_SECONDS = 2

# gemini-3.6-flash 무료 티어 하루 요청 한도(대략치, 구글이 바꿀 수 있어 환경변수로
# 덮어쓸 수 있게 해둔다). 다 쓴 뒤에 호출하면 Gemini가 어차피 거부하니, 여기서
# 먼저 걸러서 API 호출 자체를 아낀다. 카운트는 Firestore에 날짜별로 저장해서
# 서버를 재시작해도(개발 중 자주 재시작됨) 초기화되지 않게 한다.
DAILY_LIMIT = int(os.environ.get("CHAT_DAILY_LIMIT", "20"))
CHECKLIST_FIREBASE_CREDENTIALS = os.environ.get(
    "CHECKLIST_FIREBASE_CREDENTIALS", "firebase-service-account.json"
)


def _usage_doc_ref():
    import firebase_admin
    from firebase_admin import credentials, firestore

    if not firebase_admin._apps:
        cred = credentials.Certificate(CHECKLIST_FIREBASE_CREDENTIALS)
        firebase_admin.initialize_app(cred)
    today = datetime.date.today().isoformat()
    return firestore.client().collection("chat_usage").document(today)


def get_remaining_quota() -> int:
    """오늘 챗봇을 몇 번 더 쓸 수 있는지 (앱 전체 공유 한도). Firestore 연결이 안
    되면(키 파일 없음 등) 카운트를 못 세는 것뿐이니, 막지 않고 그냥 전체 한도를 돌려준다."""
    try:
        doc = _usage_doc_ref().get()
    except Exception:
        return DAILY_LIMIT
    used = doc.to_dict().get("count", 0) if doc.exists else 0
    return max(0, DAILY_LIMIT - used)


def _increment_usage() -> None:
    try:
        from firebase_admin import firestore

        _usage_doc_ref().set(
            {"count": firestore.Increment(1), "date": datetime.date.today().isoformat()},
            merge=True,
        )
    except Exception:
        pass  # 카운트 실패는 챗봇 응답 자체를 막을 이유가 안 된다.


def _mark_quota_exhausted() -> None:
    """구글이 실제로 429(RESOURCE_EXHAUSTED)를 주면, 우리 카운터를 그 자리에서
    한도까지 채워버린다. 구글 무료 티어의 하루 리셋 시각(대략 태평양 자정 기준)이
    한국 자정과 안 맞아서, 날짜 바뀜만 보고 세는 우리 카운터가 "아직 남았다"고
    잘못 표시할 수 있다 - 구글이 직접 거부했다는 건 그 자체로 가장 확실한 신호이니,
    그걸 받는 즉시 우리 쪽도 "소진"으로 맞춰서 화면이 더는 헛갈리지 않게 한다."""
    try:
        _usage_doc_ref().set(
            {"count": DAILY_LIMIT, "date": datetime.date.today().isoformat()}, merge=True
        )
    except Exception:
        pass

SYSTEM_PROMPT = """너는 'Planit'이라는 공부 계획 앱 안에 있는 학습 도우미 챗봇이다.
사용자가 업로드한 책의 목차를 바탕으로 만들어진 학습 캘린더 데이터를 참고해서,
공부 계획/진도/오늘 할 일에 대한 질문에 친절하고 간결하게 답한다.

규칙:
- 답변은 한국어로, 3~5문장 이내로 짧게 한다.
- [오늘의 학습 데이터]에 있는 내용은 사실로 취급하고, 그와 관련된 질문에는 적극 활용한다.
- 데이터에 없는 걸 지어내지 말고, 모르면 모른다고 말한다.
- 네 역할은 "물어본 것에 답하는 것"뿐이다. 사용자가 뭘 묻든(공부와 무관해도) 그 질문에만
  답하고 답변을 끝낸다.
- 답변 마지막 문장에 제안·권유·되묻는 말을 붙이지 마라. "~하실래요?", "~해보는 건
  어떨까요?", "~해보세요", "~추천해요/추천해 드려요", "~좋을 것 같아요",
  "~보시는 것도 좋아요"처럼 표현만 다를 뿐 결국 사용자에게 뭔가를 권하는 문장은
  전부 금지다. 물음표로 끝나는 문장도 금지다. 답변의 마지막 문장은 반드시
  사실을 설명하는 평서문으로 끝나야 한다 (예: "~입니다.", "~합니다.").
- 사용자가 먼저 "계획에 추가해줘"처럼 직접 요청했을 때만 그 이야기를 한다.

예시 (반드시 이 형식을 따른다):
사용자: "리눅스에 대해서 간단하게 알려줘"
올바른 답변: "리눅스는 누구나 자유롭게 수정하고 사용할 수 있는 오픈소스 운영체제입니다. 서버, 개발 환경, 클라우드 시스템 등 IT 분야에서 핵심적으로 사용됩니다."
잘못된 답변(절대 이렇게 하지 마라): "리눅스는... 사용됩니다. 혹시 리눅스 관련 과목도 공부 계획에 추가하고 싶으신가요?"
→ 잘못된 답변이 잘못된 이유: 물어보지 않은 제안을 덧붙였고 물음표로 끝났다. 올바른 답변처럼
  마지막 문장에서 바로 끝내야 한다.
"""


def _get_client() -> genai.Client:
    # 퀴즈봇(자바)도 GEMINI_API_KEY를 쓰는데, 같은 값을 공유하면 하루 무료
    # 한도(20회)를 챗봇·퀴즈봇이 나눠 쓰게 된다. CHAT_GEMINI_API_KEY가 있으면
    # 그걸 우선 쓰고, 없으면(따로 안 나눴으면) GEMINI_API_KEY로 폴백한다.
    api_key = os.environ.get("CHAT_GEMINI_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "CHAT_GEMINI_API_KEY(또는 GEMINI_API_KEY) 환경변수가 설정되어 있지 않습니다. "
            "https://aistudio.google.com/apikey 에서 무료로 키를 발급받아 설정해주세요."
        )
    return genai.Client(api_key=api_key)


def get_chat_reply(message: str, history: list[dict] | None = None, context: str = "") -> str:
    """
    message: 이번에 사용자가 보낸 메시지.
    history: [{"role": "user"|"model", "text": "..."}] 형태의 이전 대화. 프론트에서
             최근 몇 턴만 잘라 보내는 것을 전제로 한다 (토큰/비용 절약용).
    context: 오늘 학습 항목 등을 요약한 문자열. 프론트가 이미 들고 있는 캘린더
             데이터로 만들어서 보낸다 - 백엔드가 따로 Firestore를 조회하지 않는다.
    """
    if get_remaining_quota() <= 0:
        raise RuntimeError(
            f"오늘 챗봇 사용 한도({DAILY_LIMIT}회)를 다 썼어요. 내일 다시 시도해주세요."
        )

    client = _get_client()

    contents: list[types.Content] = []
    for turn in history or []:
        role = "model" if turn.get("role") == "model" else "user"
        text = turn.get("text", "")
        if not text:
            continue
        contents.append(types.Content(role=role, parts=[types.Part.from_text(text=text)]))

    user_text = message
    if context:
        user_text = f"[오늘의 학습 데이터]\n{context}\n\n[사용자 질문]\n{message}"
    contents.append(types.Content(role="user", parts=[types.Part.from_text(text=user_text)]))

    last_error: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = client.models.generate_content(
                model=MODEL_NAME,
                contents=contents,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    # 기본 temperature는 창의적으로 답을 "꾸며서" 규칙(제안 금지 등)을
                    # 잘 안 지키는 경향이 있어서 낮춘다. 챗봇은 정보 전달이 목적이라
                    # 다양성보다 지시 준수가 더 중요하다.
                    temperature=0.1,
                ),
            )
            _increment_usage()
            return response.text or "죄송해요, 답변을 생성하지 못했어요. 다시 한번 물어봐주세요."
        except errors.ServerError as e:
            # 5xx(과부하 등 일시적 오류) - 재시도하면 될 가능성이 높다.
            last_error = e
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_DELAY_SECONDS * attempt)
        except Exception as e:
            if "RESOURCE_EXHAUSTED" in str(e) or "429" in str(e):
                _mark_quota_exhausted()
                raise RuntimeError(
                    f"오늘 챗봇 사용 한도({DAILY_LIMIT}회)를 다 썼어요. 내일 다시 시도해주세요."
                ) from e
            # 그 외 4xx(키·모델명 오류) 등은 다시 물어봐도 똑같이 실패하므로 바로 포기한다.
            raise RuntimeError(f"Gemini 호출에 실패했습니다: {e}") from e

    raise RuntimeError(f"Gemini 호출에 실패했습니다({MAX_ATTEMPTS}회 재시도): {last_error}")
