# -*- coding: utf-8 -*-
"""
Anthropic API 호출부.
- ANTHROPIC_API_KEY 환경변수가 필요하다 (아직 발급 전이면 이 파일은 호출만 안 될 뿐,
  나머지 파이프라인은 mock 데이터로 테스트 가능하다 -> test_pipeline.py 참고).
- 사진(vision) 경로는 1차 파싱 후, 같은 이미지로 자기검증(self-verification)을
  한 번 더 거친다. 채팅에서 사람이 결과와 사진을 대조해 오류를 잡아주던 것을
  자동화한 것 -> 사용자 개입 없이 정확도를 끌어올리는 목적.
- 목차 사진은 여러 장(예: 목차 1페이지 사진 + 2페이지 사진)으로 나뉠 수 있어서,
  parse_toc_from_images()는 여러 장을 한 메시지에 같이 넣어 하나의 목차로 이어 읽게 한다.
"""
import os
import json
from anthropic import Anthropic

from prompt import FULL_TEXT_CHAPTER_PROMPT, TOC_PARSING_PROMPT
from postprocess import (
    add_estimated_page_counts,
    apply_non_content_keyword_filter,
    compute_end_pages,
    detect_page_order_anomalies,
    postprocess_toc_result,
    safe_json_parse,
)

MODEL_NAME = "claude-sonnet-5"

SELF_VERIFICATION_PROMPT = """방금 네가 이 목차 이미지를 분석해서 아래 JSON을 만들었다.

[1차 결과]
{first_pass_json}

이미지를 다시 자세히 보고, 특히 다음을 중점적으로 재검토해라:
1. 각 항목의 startPage가 이미지에 실제로 인쇄된 숫자와 정확히 일치하는가?
2. **가장 흔하고 치명적인 실수: 페이지 번호가 한 칸씩 밀려서 배정되는 것.**
   각 항목의 제목과 페이지 번호가 실제로 이미지에서 같은 가로줄(행)에
   있는 게 맞는지 하나씩 손가락으로 짚듯이 확인해라. 예를 들어 항목 A의
   페이지 번호로 되어 있는 값이 사실 이미지에서는 바로 다음 항목 B의 줄에
   더 가깝게 인쇄되어 있다면, 그건 밀림 실수다. 이 경우 A, B, C... 전체
   목록의 페이지 번호를 한 칸씩 앞으로 당겨서 다시 짝지어야 한다.
3. 페이지 번호가 챕터/섹션 순서대로 오름차순인가? (뒤 항목이 앞 항목보다 페이지가
   작거나 같으면 잘못 읽은 것이다. 단, 오름차순이라고 해서 안심하지 말 것 —
   전체가 한 칸씩 밀려도 오름차순 자체는 유지되므로 이 검사만으로는
   밀림을 걸러낼 수 없다. 반드시 2번처럼 행 단위로 직접 대조해라.)
4. startPage를 null로 남긴 항목이 있다면, 이미지에서 정말 안 보이는 게 맞는지
   다시 한번 확인해라 (특히 위아래 항목과 줄이 헷갈렸을 가능성을 의심해라)
5. 챕터/섹션 제목 자체가 정확한가?
6. 이미지가 여러 장 주어졌다면, 장 사이의 이어짐(예: 1번째 이미지 마지막 항목
   다음에 2번째 이미지 첫 항목이 자연스럽게 이어지는지)도 확인해라.

수정 과정을 짧게 텍스트로 정리해도 되지만, 최종 결과는 반드시 ```json
코드블록 하나로 감싸서 출력하고, 코드블록 안에는 JSON 외의 텍스트를 넣지 마라.
"""


def _get_client() -> Anthropic:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다. "
            "console.anthropic.com에서 키를 발급받아 설정해주세요."
        )
    return Anthropic(api_key=api_key)


def parse_toc_from_text(toc_text: str, total_pages: int | None = None, max_retries: int = 2) -> dict:
    """PDF에서 추출한 목차 텍스트를 LLM에 넘겨 구조화된 JSON을 얻는다."""
    client = _get_client()
    last_error = None

    for attempt in range(max_retries + 1):
        response = client.messages.create(
            model=MODEL_NAME,
            max_tokens=8000,
            messages=[
                {"role": "user", "content": TOC_PARSING_PROMPT + "\n\n[입력 목차 텍스트]\n" + toc_text}
            ],
        )
        raw_text = "".join(
            block.text for block in response.content if getattr(block, "type", "") == "text"
        )
        try:
            return postprocess_toc_result(raw_text, total_pages=total_pages)
        except Exception as e:  # JSON 파싱 실패 등
            last_error = e
            continue

    raise RuntimeError(f"목차 파싱 실패 (재시도 {max_retries}회 소진): {last_error}")


def _chunk_pages(pages: list[dict], chunk_chars: int) -> list[list[dict]]:
    """
    페이지 목록을 글자 수 기준으로 구간(청크)으로 나눈다. 한 청크가 너무 커서
    LLM 컨텍스트/출력 한도를 넘기지 않게 하기 위함 - 페이지 경계는 항상
    지킨다(한 페이지가 두 청크에 걸쳐 잘리지 않는다).
    """
    chunks: list[list[dict]] = []
    current: list[dict] = []
    current_len = 0
    for p in pages:
        current.append(p)
        current_len += len(p["text"])
        if current_len >= chunk_chars:
            chunks.append(current)
            current = []
            current_len = 0
    if current:
        chunks.append(current)
    return chunks


def parse_toc_from_full_text(
    pages: list[dict],
    total_pages: int | None = None,
    chunk_chars: int = 30000,
    max_retries: int = 2,
) -> dict:
    """
    목차 페이지가 없는 PDF용: pdf_extract.extract_all_pages_text()가 뽑아낸
    페이지별 본문을 그대로 LLM에 읽혀서, 목차 형식에 기대지 않고 AI가 직접
    학습 단위(장/절/항목)를 판단하게 한다. 문서가 길면 여러 구간(청크)으로
    나눠 각각 호출한 뒤 결과를 하나로 합친다 - 청크 하나가 LLM 컨텍스트를
    넘지 않게 하기 위함이며, 각 청크는 실제 페이지 번호가 적힌 [p.N] 마커를
    보고 startPage를 채우므로 청크 경계와 무관하게 정확하다.

    청크별 파싱까지만 하고(safe_json_parse), endPage 계산/이상치 검증 등은
    전체 챕터를 합친 뒤 한 번만 수행한다 - endPage는 "다음 챕터의 startPage"에
    의존하는데, 그 다음 챕터가 다른 청크에 있을 수 있기 때문이다.
    """
    client = _get_client()
    chunks = _chunk_pages(pages, chunk_chars)

    all_chapters: list[dict] = []
    order_offset = 0
    for chunk in chunks:
        chunk_text = "\n\n".join(f"[p.{p['page']}]\n{p['text']}" for p in chunk)
        page_range = f"{chunk[0]['page']}~{chunk[-1]['page']}"
        prompt = FULL_TEXT_CHAPTER_PROMPT.format(page_range=page_range)

        parsed_chunk = None
        last_error = None
        for attempt in range(max_retries + 1):
            response = client.messages.create(
                model=MODEL_NAME,
                # 두꺼운 책은 청크 하나에도 챕터/항목이 많이 나올 수 있어 여유를 둔다.
                max_tokens=16000,
                messages=[
                    {"role": "user", "content": prompt + "\n\n[본문]\n" + chunk_text}
                ],
            )
            raw_text = "".join(
                block.text for block in response.content if getattr(block, "type", "") == "text"
            )
            try:
                parsed_chunk = safe_json_parse(raw_text)
                break
            except Exception as e:
                last_error = e
                continue

        if parsed_chunk is None:
            raise RuntimeError(f"목차 추정 실패 (p.{page_range}, 재시도 {max_retries}회 소진): {last_error}")

        # 청크마다 order가 1부터 다시 시작하므로, 청크 순서를 보존하도록 오프셋을 더한다
        # (한 청크에 챕터가 1000개를 넘는 비정상적인 경우가 아니면 겹치지 않는다).
        for ch in parsed_chunk.get("chapters", []):
            ch["order"] = order_offset + ch.get("order", 0)
            all_chapters.append(ch)
        order_offset += 1000

    merged = {"chapters": all_chapters}
    merged = detect_page_order_anomalies(merged)
    merged = compute_end_pages(merged, total_pages=total_pages)
    merged = apply_non_content_keyword_filter(merged)
    merged = add_estimated_page_counts(merged)
    return merged


def _batch_pages(pages: list[dict], batch_size: int) -> list[list[dict]]:
    """페이지 번호 목록을 batch_size개씩 묶는다 (이미지 청크용 - 글자 수 대신 개수 기준)."""
    return [pages[i:i + batch_size] for i in range(0, len(pages), batch_size)]


def parse_toc_from_page_images(
    pdf_path: str,
    page_count: int,
    total_pages: int | None = None,
    batch_pages: int = 10,
    max_retries: int = 2,
) -> dict:
    """
    텍스트 레이어가 없는 PDF용: 목차 형식에 기대지 않고 AI가 페이지 이미지를
    직접 읽어 구조를 판단하게 한다. parse_toc_from_full_text와 원리는 같고
    (청크로 나눠 각각 호출 후 병합), 본문이 텍스트가 아니라 이미지라는 점만
    다르다.

    페이지 전체를 미리 렌더링해서 들고 있지 않고, 배치(batch_pages장)마다
    그때그때 render_pages_as_images를 불러 렌더링한 뒤 전송하고 버린다 -
    문서가 길면(수십~수백 페이지) 전체를 한 번에 이미지로 들고 있는 것만으로도
    메모리를 꽤 쓰는데(특히 여유 메모리가 적은 환경에서는 렌더링 중 메모리
    할당 자체가 실패할 수 있다), 이렇게 하면 항상 배치 하나 분량만큼만
    메모리에 있는다.

    각 이미지 앞에 "[p.N]" 텍스트 블록을 넣어 페이지 번호를 알려준다 - 이미지
    자체에는 파일 안에 마커를 심을 수 없으므로, 같은 메시지 안에서 이미지
    바로 앞에 그 이미지의 페이지 번호를 알리는 텍스트를 배치해 대신한다.
    """
    from pdf_extract import render_pages_as_images  # 지역 import: 순환 참조 방지

    client = _get_client()
    page_batches = _batch_pages(list(range(1, page_count + 1)), batch_pages)

    all_chapters: list[dict] = []
    order_offset = 0
    for page_numbers in page_batches:
        batch = render_pages_as_images(pdf_path, page_numbers=page_numbers)
        page_range = f"{batch[0]['page']}~{batch[-1]['page']}"
        prompt = FULL_TEXT_CHAPTER_PROMPT.format(page_range=page_range)

        content = []
        for p in batch:
            content.append({"type": "text", "text": f"[p.{p['page']}]"})
            content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": p["media_type"], "data": p["data"]},
            })
        content.append({"type": "text", "text": prompt})

        parsed_batch = None
        last_error = None
        for attempt in range(max_retries + 1):
            response = client.messages.create(
                model=MODEL_NAME,
                max_tokens=16000,
                messages=[{"role": "user", "content": content}],
            )
            raw_text = "".join(
                block.text for block in response.content if getattr(block, "type", "") == "text"
            )
            try:
                parsed_batch = safe_json_parse(raw_text)
                break
            except Exception as e:
                last_error = e
                continue

        if parsed_batch is None:
            raise RuntimeError(f"목차 추정 실패 (p.{page_range}, 재시도 {max_retries}회 소진): {last_error}")

        for ch in parsed_batch.get("chapters", []):
            ch["order"] = order_offset + ch.get("order", 0)
            all_chapters.append(ch)
        order_offset += 1000

    merged = {"chapters": all_chapters}
    merged = detect_page_order_anomalies(merged)
    merged = compute_end_pages(merged, total_pages=total_pages)
    merged = apply_non_content_keyword_filter(merged)
    merged = add_estimated_page_counts(merged)
    return merged


def _call_vision_once(client: Anthropic, images: list[dict], prompt_text: str) -> str:
    """
    이미지 여러 장 + 프롬프트로 1회 호출하고 텍스트 응답을 반환하는 내부 헬퍼.
    images: [{"data": base64_str, "media_type": "image/jpeg"}, ...] 순서대로
            한 메시지 안에 같이 담아 보낸다 (여러 장이어도 API 호출은 1번).
    """
    content = [
        {
            "type": "image",
            "source": {"type": "base64", "media_type": img["media_type"], "data": img["data"]},
        }
        for img in images
    ]
    content.append({"type": "text", "text": prompt_text})

    response = client.messages.create(
        model=MODEL_NAME,
        max_tokens=8000,
        messages=[{"role": "user", "content": content}],
    )
    return "".join(
        block.text for block in response.content if getattr(block, "type", "") == "text"
    )


def parse_toc_from_images(images: list[dict], total_pages: int | None = None,
                           max_retries: int = 2, self_verify: bool = True) -> dict:
    """
    목차 사진 한 장 이상(base64 리스트)을 vision 모델에 한 번에 넘겨 구조화된 JSON을 얻는다.
    images: [{"data": base64_str, "media_type": "image/jpeg"}, ...]
    - 목차가 여러 장으로 나뉘어 촬영된 경우(예: 1페이지/2페이지 따로 찍음), 프롬프트가
      이걸 하나의 목차로 이어 붙여 처리하도록 지시한다.
    - self_verify=True(기본값)면, 1차 결과를 같은 이미지들로 한 번 더 검증/보정한다.
      이 과정은 전부 자동으로 이루어지며 사용자에게는 노출되지 않는다.
    """
    client = _get_client()
    last_error = None

    for attempt in range(max_retries + 1):
        try:
            raw_text = _call_vision_once(client, images, TOC_PARSING_PROMPT)

            if self_verify:
                try:
                    first_pass_parsed = safe_json_parse(raw_text)
                    verify_prompt = SELF_VERIFICATION_PROMPT.format(
                        first_pass_json=json.dumps(first_pass_parsed, ensure_ascii=False, indent=2)
                    )
                    verified_text = _call_vision_once(client, images, verify_prompt)
                    raw_text = verified_text
                except Exception:
                    pass

            return postprocess_toc_result(raw_text, total_pages=total_pages)
        except Exception as e:
            last_error = e
            continue

    raise RuntimeError(f"목차 파싱 실패 (재시도 {max_retries}회 소진): {last_error}")


def parse_toc_from_image(image_base64: str, media_type: str = "image/jpeg",
                          total_pages: int | None = None, max_retries: int = 2,
                          self_verify: bool = True) -> dict:
    """
    목차 사진 한 장짜리 버전 (하위 호환용). 내부적으로 parse_toc_from_images를 호출한다.
    """
    return parse_toc_from_images(
        [{"data": image_base64, "media_type": media_type}],
        total_pages=total_pages, max_retries=max_retries, self_verify=self_verify,
    )