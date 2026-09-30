# -*- coding: utf-8 -*-
"""
React 프론트엔드와 연결하기 위한 FastAPI 서버.
- 로컬 개발용. `uvicorn server:app --reload`로 실행한다.
- 목차 파싱(사진 여러 장/PDF)과 학습 플랜 생성을 각각 엔드포인트로 노출한다.
"""
import base64
import os
import tempfile
from datetime import date, timedelta
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from api_call import (
    parse_toc_from_full_text,
    parse_toc_from_images,
    parse_toc_from_page_images,
    parse_toc_from_text,
)
from pdf_extract import extract_all_pages_text, extract_toc_text, get_page_count
from schedule import generate_study_plan
from chat_call import DAILY_LIMIT, get_chat_reply, get_remaining_quota
from checklist_sync import (
    fetch_plan_from_firestore,
    fetch_plan_meta,
    mark_leaves_excluded,
    member_id_for_user,
    move_item_in_firestore,
    push_plan_to_firestore,
    save_plan_meta,
    study_plan_id_for_user,
)

app = FastAPI(title="Planit TOC Parser")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 팀원의 "할일 체크리스트" 백엔드(Planit-Web-Checklist-main)와 공유하는 Firestore
# 서비스 계정 키 경로. 플랜 저장/조회/이동을 전부 여기(Firestore)에 직접 한다 -
# 더 이상 메모리(PLANS_STORE)에 따로 들고 있지 않는다.
CHECKLIST_FIREBASE_CREDENTIALS = os.environ.get(
    "CHECKLIST_FIREBASE_CREDENTIALS", "firebase-service-account.json"
)


def _require_firestore_credentials() -> None:
    if not os.path.exists(CHECKLIST_FIREBASE_CREDENTIALS):
        raise HTTPException(
            status_code=503,
            detail=(
                f"{CHECKLIST_FIREBASE_CREDENTIALS} 파일이 없어서 플랜 저장소(Firestore)에 "
                "연결할 수 없습니다. 팀원에게 받은 서비스 계정 키 파일을 이 서버 루트에 넣어주세요."
            ),
        )


@app.post("/parse-toc/image")
async def parse_toc_image(
    files: list[UploadFile] = File(...),
    total_pages: int | None = Form(None),
):
    """
    목차 사진을 한 장 이상 업로드하면 구조화된 챕터 JSON을 반환한다.
    목차가 여러 장으로 나뉘어 촬영된 경우, 여러 파일을 같은 요청에 함께 보내면
    하나로 이어 붙여 파싱한다.
    """
    images = []
    for f in files:
        image_bytes = await f.read()
        images.append({
            "data": base64.b64encode(image_bytes).decode(),
            "media_type": f.content_type or "image/jpeg",
        })

    try:
        # parse_toc_from_images는 Anthropic SDK를 동기(블로킹) 방식으로 호출한다.
        # await 없이 그냥 부르면 이 호출이 끝날 때까지 서버 전체(단일 이벤트
        # 루프)가 다른 요청을 하나도 처리 못 한다 - 스레드풀에서 돌려서
        # 이벤트 루프를 막지 않게 한다.
        result = await run_in_threadpool(parse_toc_from_images, images, total_pages=total_pages)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return result


@app.post("/parse-toc/pdf")
async def parse_toc_pdf(
    file: UploadFile = File(...),
    total_pages: int | None = Form(None),
):
    """
    PDF를 업로드하면 구조화된 챕터 JSON을 반환한다. 세 경로 중 하나를 자동으로 탄다:
    1. 목차 페이지를 찾으면 그 페이지 텍스트만 분석한다 (가장 저렴하고 빠름).
    2. 목차는 없지만 텍스트 레이어는 있으면(수험서, 요약노트 등 흔한 경우) 본문
       전체를 AI에게 그대로 읽혀서 형식에 기대지 않고 구조를 판단하게 한다.
    3. 텍스트 레이어가 아예 없으면(스캔본이거나, 글자를 폰트가 아니라 벡터
       도형으로 그린 PDF) 페이지를 이미지로 렌더링해서 사진과 같은 비전
       경로로 읽는다 - 이 경우 사용자가 따로 사진을 다시 올릴 필요가 없다.
    """
    pdf_bytes = await file.read()

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name

    try:
        # 아래 전부(PDF 텍스트/이미지 추출, AI 호출)는 동기(블로킹) 함수라서
        # 이벤트 루프에서 직접 부르면 이 요청이 끝날 때까지 서버가 다른 요청을
        # 하나도 못 받는다(특히 AI 호출은 목차 없는 두꺼운 PDF에서 몇 분씩
        # 걸릴 수 있다) - 전부 스레드풀에서 돌린다.
        toc_text = await run_in_threadpool(extract_toc_text, tmp_path)
        if toc_text is not None:
            result = await run_in_threadpool(parse_toc_from_text, toc_text, total_pages=total_pages)
        else:
            pages = await run_in_threadpool(extract_all_pages_text, tmp_path)
            if any(p["text"].strip() for p in pages):
                result = await run_in_threadpool(parse_toc_from_full_text, pages, total_pages=total_pages)
            else:
                page_count = await run_in_threadpool(get_page_count, tmp_path)
                result = await run_in_threadpool(
                    parse_toc_from_page_images, tmp_path, page_count, total_pages=total_pages
                )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    return result


class GeneratePlanRequest(BaseModel):
    """
    parsedToc: postprocess_toc_result() 형태의 결과. 사용자가 과목 선택 화면에서
               체크 해제한 챕터는 프론트에서 이미 제외하고 보내는 것을 전제로 한다.
    startDate/targetDate: 학습 시작일/목표일 (둘 다 포함).
    weekdayMinutes: {"월": 120, ..., "토": 0, "일": 0} 형태의 요일별 가용 시간(분).
                    프론트에서 평일/주말 범위를 분으로 환산해 7일치로 채워서 보낸다.
    checkedDates: 캘린더에서 사용자가 체크한(=학습 가능한) 날짜 목록. 이 목록에
                  없는, 시작일~목표일 범위 안의 날짜는 전부 제외일로 처리한다.
    userId: 로그인 파트에서 내려주는 사용자 식별자. 있으면 생성된 플랜을 저장해서
            메인페이지가 나중에 /plans/{user_id}로 다시 조회할 수 있게 한다.
    excludedLeafKeys: 과목 선택 화면에서 이번에 체크 해제한 단원들의 키
                      (frontend/src/lib/toc.js의 getLeafUnits 키 규칙과 동일).
                      "계획 다시 생성하기"를 또 눌렀을 때 이 단원들이 기본값에서
                      다시 체크된 채로 나타나지 않게, study_plans에 영구 누적해둔다.
    """
    parsedToc: dict
    startDate: date
    targetDate: date
    weekdayMinutes: dict[str, int]
    checkedDates: list[date]
    userId: str | None = None
    excludedLeafKeys: list[str] = []


@app.post("/generate-plan")
async def generate_plan(req: GeneratePlanRequest):
    """
    선택된 챕터 + 기간/시간 설정을 받아 날짜별 학습 플랜을 생성하고, userId가 있으면
    Firestore "study_plan_items" 컬렉션에 바로 저장한다 (팀원의 체크리스트 백엔드가
    읽는 곳과 같은 컬렉션 - 별도 동기화 스크립트를 돌릴 필요 없이 여기서 바로 반영됨).
    """
    all_days = []
    d = req.startDate
    while d <= req.targetDate:
        all_days.append(d)
        d += timedelta(days=1)

    checked_set = set(req.checkedDates)
    excluded_dates = [d for d in all_days if d not in checked_set]

    try:
        result = generate_study_plan(
            req.parsedToc,
            start_date=req.startDate,
            target_date=req.targetDate,
            weekday_minutes=req.weekdayMinutes,
            excluded_dates=excluded_dates,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    if req.userId:
        _require_firestore_credentials()
        study_plan_id = study_plan_id_for_user(req.userId)
        try:
            push_plan_to_firestore(
                result,
                member_id=member_id_for_user(req.userId),
                study_plan_id=study_plan_id,
                credentials_path=CHECKLIST_FIREBASE_CREDENTIALS,
            )
            mark_leaves_excluded(
                study_plan_id,
                req.excludedLeafKeys,
                credentials_path=CHECKLIST_FIREBASE_CREDENTIALS,
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"플랜 저장 실패: {e}")

    return result


class SaveTocRequest(BaseModel):
    """
    UploadScreen에서 목차 파싱(AI 분석)이 막 끝난 원본 parsedToc(과목 선택 전, 필터링
    전 전체 목차)을 저장해둘 때 쓴다. "계획 다시 생성하기"를 누르면 사진 촬영/AI 분석
    단계 없이 이 원본을 그대로 다시 불러와서 과목 선택 화면부터 마법사를 다시 태운다.
    """
    parsedToc: dict
    source: str | None = None


@app.put("/plans/{user_id}/toc")
async def save_toc(user_id: str, req: SaveTocRequest):
    _require_firestore_credentials()
    try:
        save_plan_meta(
            study_plan_id=study_plan_id_for_user(user_id),
            parsed_toc=req.parsedToc,
            source=req.source,
            credentials_path=CHECKLIST_FIREBASE_CREDENTIALS,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"목차 저장 실패: {e}")
    return {"status": "ok"}


@app.get("/plans/{user_id}/toc")
async def get_toc(user_id: str):
    """
    "계획 다시 생성하기" 버튼이 호출한다. 저장해둔 원본 목차가 있으면 그걸 그대로
    돌려줘서, 프론트가 목차 업로드 단계를 건너뛰고 과목 선택 화면부터 마법사를
    다시 시작할 수 있게 한다.
    """
    _require_firestore_credentials()
    try:
        meta = fetch_plan_meta(study_plan_id_for_user(user_id), credentials_path=CHECKLIST_FIREBASE_CREDENTIALS)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"목차 조회 실패: {e}")

    if meta is None:
        raise HTTPException(
            status_code=404,
            detail="저장된 목차가 없습니다. 목차 업로드부터 다시 진행해주세요.",
        )
    return {
        "parsedToc": meta["parsedToc"],
        "excludedLeafKeys": meta.get("excludedLeafKeys", []),
        "source": meta.get("source"),
    }


@app.get("/plans/{user_id}")
async def get_plan(user_id: str):
    """
    메인페이지 캘린더가 Firestore에서 사용자의 학습 플랜을 조회할 때 쓰는 엔드포인트.
    오늘 할 일(체크리스트)은 이 응답에서 오늘 날짜에 해당하는 항목만 프론트에서
    걸러서 보여준다 - 별도로 팀원 API를 호출할 필요가 없다. memberId는 진도율
    체크(PATCH .../progress)를 프론트가 팀원 API로 직접 호출할 때 필요해서 같이 내려준다.
    """
    _require_firestore_credentials()
    try:
        plan = fetch_plan_from_firestore(
            study_plan_id_for_user(user_id),
            credentials_path=CHECKLIST_FIREBASE_CREDENTIALS,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"플랜 조회 실패: {e}")

    if not plan["days"]:
        raise HTTPException(status_code=404, detail="저장된 플랜이 없습니다.")

    plan["memberId"] = member_id_for_user(user_id)
    meta = fetch_plan_meta(study_plan_id_for_user(user_id), credentials_path=CHECKLIST_FIREBASE_CREDENTIALS)
    plan["source"] = meta.get("source") if meta else None
    return plan


class MoveItemRequest(BaseModel):
    itemId: str
    toDate: str


@app.post("/plans/{user_id}/move-item")
async def move_item(user_id: str, req: MoveItemRequest):
    """메인 달력에서 항목을 다른 날짜로 드래그해서 옮겼을 때 호출된다."""
    _require_firestore_credentials()
    try:
        move_item_in_firestore(req.itemId, req.toDate, credentials_path=CHECKLIST_FIREBASE_CREDENTIALS)
        plan = fetch_plan_from_firestore(
            study_plan_id_for_user(user_id),
            credentials_path=CHECKLIST_FIREBASE_CREDENTIALS,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"항목 이동 실패: {e}")

    plan["memberId"] = member_id_for_user(user_id)
    return plan


@app.get("/health")
async def health():
    """React 쪽에서 서버가 켜져있는지 확인할 때 쓸 수 있는 간단한 상태 체크용."""
    return {"status": "ok"}


class ChatMessage(BaseModel):
    role: str  # "user" | "model"
    text: str


class ChatRequest(BaseModel):
    """
    message: 이번에 사용자가 입력한 메시지.
    history: 최근 대화 몇 턴 (프론트 ChatbotScreen이 화면에 쌓아둔 것을 그대로 보낸다).
    context: "오늘 할 일: ..." 처럼 프론트가 이미 들고 있는 캘린더 데이터를 한국어
             문장으로 요약한 문자열. 없어도 되지만(빈 문자열), 있으면 챗봇이 실제
             사용자의 오늘 학습 항목을 참고해서 답한다.
    """
    message: str
    history: list[ChatMessage] = []
    context: str = ""


@app.get("/chat/quota")
async def chat_quota():
    """채팅창 열자마자 '오늘 몇 번 남았는지'부터 보여주기 위한 조회용 - 메시지를 안 보내도 된다."""
    return {"remaining": get_remaining_quota(), "dailyLimit": DAILY_LIMIT}


@app.post("/chat")
async def chat(req: ChatRequest):
    """시연용 학습 도우미 챗봇. Gemini 무료 티어를 쓴다 (chat_call.py 참고)."""
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="메시지를 입력해주세요.")

    try:
        reply = get_chat_reply(
            req.message,
            history=[m.model_dump() for m in req.history],
            context=req.context,
        )
    except RuntimeError as e:
        # GEMINI_API_KEY 미설정, 오늘 한도 소진 등 - 프론트가 그대로 보여줄 수 있게 전달.
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"챗봇 응답 생성 실패: {e}")

    return {"reply": reply, "remaining": get_remaining_quota(), "dailyLimit": DAILY_LIMIT}