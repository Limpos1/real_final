# -*- coding: utf-8 -*-
"""
PDF에서 텍스트를 추출한다. 텍스트 레이어가 있는 PDF 전제 (스캔본은 vision
경로로 처리 필요).

목차 페이지를 찾으면 그 페이지만 뽑아서 쓰고(extract_toc_text), 못 찾으면
(수험서, 요약노트 등 목차 없는 PDF가 흔하다) 본문 전체를 페이지별로 뽑아서
(extract_all_pages_text) AI에게 그대로 읽혀 직접 구조를 판단하게 한다 -
api_call.py의 parse_toc_from_full_text 참고. 글자 크기 등으로 "제목 후보"를
미리 걸러내는 방식은 PDF마다 형식이 워낙 제각각이라(전통적 교재, 카드형
요약노트, 기출문제집 등) 오히려 AI가 볼 수 있는 문맥을 제한해서 정확도를
떨어뜨린다고 판단해 버렸다.
"""
import base64

import pdfplumber

# 목차 페이지를 자동으로 찾기 위한 단순 휴리스틱 키워드
TOC_HINT_KEYWORDS = ["목차", "차례", "Contents", "CONTENTS", "Table of Contents"]


def _find_column_gutter(page, min_gap: float = 15.0, center_zone: float = 0.15) -> float | None:
    """
    2단(좌우 칼럼) 편집인 페이지에서, 칼럼을 가르는 세로 여백(gutter)의 x좌표를 찾는다.
    - 페이지 중앙 근처(center_zone 비율 이내)에서, 단어 x0 좌표들 사이에 min_gap포인트
      이상 벌어진 빈 구간을 찾는다. 못 찾으면(단일 칼럼) None을 반환한다.
    - 수험서/요약노트류가 대부분 2단 편집이라, 이걸 안 하면 왼쪽·오른쪽 칼럼 텍스트가
      세로 위치만 보고 한 줄처럼 섞여 읽혀서(예: 왼쪽 칼럼 끝 단어 다음에 오른쪽 칼럼
      단어가 바로 이어짐) 목차 인식과 제목 후보 추출이 둘 다 엉망이 된다.
    """
    words = page.extract_words()
    if not words:
        return None
    xs = sorted(w["x0"] for w in words)
    mid = page.width / 2
    best = None
    for prev_x, cur_x in zip(xs, xs[1:]):
        gap = cur_x - prev_x
        gap_mid = (prev_x + cur_x) / 2
        if gap >= min_gap and abs(gap_mid - mid) <= page.width * center_zone:
            if best is None or gap > best[0]:
                best = (gap, gap_mid)
    return best[1] if best else None


def _extract_page_text(page) -> str:
    """
    페이지 텍스트를 칼럼 순서를 지켜서 추출한다. 2단 편집이면 왼쪽 칼럼 전체를
    위에서 아래로 읽은 뒤 오른쪽 칼럼을 이어붙이고, 단일 칼럼이면 기본 추출 그대로다.
    """
    gutter_x = _find_column_gutter(page)
    if gutter_x is None:
        return page.extract_text() or ""
    left = page.crop((0, 0, gutter_x, page.height))
    right = page.crop((gutter_x, 0, page.width, page.height))
    return f"{left.extract_text() or ''}\n{right.extract_text() or ''}"


def extract_text_from_pages(pdf_path: str, page_indices: list[int]) -> str:
    """지정한 페이지(0-indexed)들의 텍스트를 이어붙여 반환한다."""
    texts = []
    with pdfplumber.open(pdf_path) as pdf:
        for idx in page_indices:
            if 0 <= idx < len(pdf.pages):
                texts.append(_extract_page_text(pdf.pages[idx]))
    return "\n".join(texts)


def find_toc_page_candidates(pdf_path: str, max_scan_pages: int = 15) -> list[int]:
    """
    앞부분 max_scan_pages 페이지 중, 목차로 추정되는 페이지 인덱스를 찾는다.
    - 키워드("목차", "차례", "Contents")가 페이지 위쪽에 "제목 줄 자체"로 있거나
    - 페이지 번호 패턴(마침표 리더, 숫자로 끝나는 줄)이 "대부분의 줄"에 등장하는
      페이지를 후보로 본다.

    둘 다 예전엔 더 느슨했는데(키워드는 본문 어디든 포함되면 매치, 숫자 조건은
    절대 개수 5개 이상), 본문이 빽빽한 수험서에서 오작동했다:
    - "차례"는 "순서대로"라는 뜻의 흔한 단어라 본문에 우연히 자주 등장하고,
      "목차"도 "도식 목차"(HIPO 용어) 같은 문구 안에 섞여 나올 수 있다. 그래서
      키워드는 "페이지 위쪽 몇 줄 중, 그 줄 전체가 키워드와 거의 같을 때"만
      인정한다 (실제 목차 페이지는 맨 위에 "목차"라는 제목만 딱 있는 게 보통).
    - 연도별 출제 빈도("24.7, 24.2, ...")나 코드 번호가 자주 섞여 나오는 본문
      페이지는 숫자로 끝나는 줄의 절대 개수가 5~15개씩 나온다. 그래서 "줄 전체
      대비 숫자로 끝나는 줄의 비율"도 같이 본다 - 실제 목차 페이지는 거의 모든
      줄이 "제목 ... 쪽번호"라 비율이 압도적으로 높고(대부분 0.6 이상), 본문
      페이지는 절대 개수가 많아도 비율은 낮다(실측 0.05~0.33).
    """
    candidates = []
    with pdfplumber.open(pdf_path) as pdf:
        scan_range = min(max_scan_pages, len(pdf.pages))
        for i in range(scan_range):
            text = _extract_page_text(pdf.pages[i])
            lines = [l.strip() for l in text.splitlines() if l.strip()]
            if not lines:
                continue

            heading_lines = lines[:5]
            if any(
                len(line) <= len(kw) + 5 and kw.lower() in line.lower()
                for line in heading_lines
                for kw in TOC_HINT_KEYWORDS
            ):
                candidates.append(i)
                continue

            numeric_ending_lines = sum(1 for line in lines if line[-1].isdigit())
            if numeric_ending_lines >= 5 and numeric_ending_lines / len(lines) >= 0.4:
                candidates.append(i)
    return candidates


def extract_toc_text(pdf_path: str) -> str | None:
    """
    목차 후보 페이지들을 자동 탐색해서 텍스트로 반환한다.
    후보를 하나도 못 찾으면 None을 반환한다 (예전엔 앞 5페이지를 그냥 넘겼는데,
    그게 대부분 표지/저작권 페이지라 AI가 목차를 못 찾고 실패하는 원인이었다.
    호출부에서 None이면 extract_all_pages_text()로 넘어가야 한다).
    """
    candidates = find_toc_page_candidates(pdf_path)
    if not candidates:
        return None
    return extract_text_from_pages(pdf_path, candidates)


def extract_all_pages_text(pdf_path: str) -> list[dict]:
    """
    목차 페이지가 없는 PDF용: 전체 페이지를 칼럼 순서를 지켜 텍스트로 추출해
    페이지별로 반환한다. 어떤 "제목 후보"를 미리 거르지 않고 본문 그대로
    넘긴다 - 구조 판단은 전부 api_call.py의 parse_toc_from_full_text가 AI에게
    맡긴다.
    반환: [{"page": 1부터 시작하는 정수, "text": "..."}, ...] (문서 순서대로)
    """
    pages = []
    with pdfplumber.open(pdf_path) as pdf:
        for idx, page in enumerate(pdf.pages):
            pages.append({"page": idx + 1, "text": _extract_page_text(page)})
    return pages


def get_page_count(pdf_path: str) -> int:
    """PDF의 총 페이지 수. render_pages_as_images를 배치로 나눠 부르기 전에 쓴다."""
    import fitz

    doc = fitz.open(pdf_path)
    try:
        return len(doc)
    finally:
        doc.close()


def render_pages_as_images(
    pdf_path: str, page_numbers: list[int] | None = None, dpi: int = 150
) -> list[dict]:
    """
    텍스트 레이어가 없는 PDF용: 페이지를 이미지로 그려서 반환한다.
    - 글자가 폰트가 아니라 벡터 도형(윤곽선)으로 그려진 PDF(일부 출판사가
      폰트 라이선스/인쇄 호환 문제를 피하려고 이렇게 만든다)는 pdfplumber로
      텍스트를 한 글자도 못 뽑는다 - 스캔본과 증상은 같지만 원인은 다르다.
    - 이런 페이지는 사람이 봐도 그냥 인쇄된 페이지라, 실제 스캔본과 똑같이
      "이미지"로 취급해서 기존 사진(비전) 경로로 읽으면 된다 - AI는 이미지
      속 글자를 직접 읽을 수 있으므로 텍스트 레이어 유무와 무관하다.
    - page_numbers(1부터 시작하는 페이지 번호 목록)를 넘기면 그 페이지만
      렌더링한다. api_call.py의 parse_toc_from_page_images가 이걸 배치
      단위(예: 10페이지)로 나눠 호출해서, 문서 전체를 한 번에 메모리에
      올리지 않는다 - 페이지 수가 많은 PDF를 렌더링하면 메모리를 꽤 쓰는데
      (특히 여유 메모리가 적은 환경에서는 할당 실패까지 날 수 있다), 필요한
      배치만큼만 그때그때 렌더링하고 버리면 최대 메모리 사용량이 훨씬 준다.
      None이면(기본값) 전체 페이지를 렌더링한다.
    - PyMuPDF(fitz)가 필요하다: pip install pymupdf
    반환: [{"page": 1부터 시작하는 정수, "data": base64 PNG, "media_type": "image/png"}, ...]
    """
    import fitz  # PyMuPDF - pdfplumber와 달리 텍스트 레이어 없이도 페이지를 래스터화할 수 있다

    pages = []
    doc = fitz.open(pdf_path)
    try:
        indices = [n - 1 for n in page_numbers] if page_numbers is not None else range(len(doc))
        for idx in indices:
            pix = doc[idx].get_pixmap(dpi=dpi)
            pages.append({
                "page": idx + 1,
                "data": base64.b64encode(pix.tobytes("png")).decode(),
                "media_type": "image/png",
            })
    finally:
        doc.close()
    return pages
