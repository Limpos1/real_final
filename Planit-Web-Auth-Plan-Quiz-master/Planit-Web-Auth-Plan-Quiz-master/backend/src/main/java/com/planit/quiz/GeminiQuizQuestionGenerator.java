package com.planit.quiz;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import lombok.extern.slf4j.Slf4j;

/**
 * Google Gemini(Generative Language API)로 오늘 학습 범위에 맞는 퀴즈 3문항을 생성한다 (REQ-Q-002, REQ-Q-003).
 * 쉬운 문제(BASIC) 2개 + 응용 문제(APPLIED) 1개.
 *
 * <pre>
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}
 * </pre>
 *
 * API 키는 application.yml 의 {@code gemini.api-key} (환경변수 {@code GEMINI_API_KEY} 로 주입).
 * 키가 없거나 호출·파싱·검증이 실패하면 {@link MockQuizQuestionGenerator} 의 고정 예시로 자동 폴백한다.
 * → 키가 없어도 퀴즈봇은 항상 동작한다.
 *
 * {@code @Primary} 라서 QuizService 는 이 구현체를 주입받는다.
 */
@Slf4j
@Component
@Primary
public class GeminiQuizQuestionGenerator implements QuizQuestionGenerator {

	private static final String BASE_URL = "https://generativelanguage.googleapis.com";
	private static final String DEFAULT_MODEL = "gemini-3.6-flash";
	private static final int REQUIRED_COUNT = 3;
	private static final int MAX_ATTEMPTS = 3;
	private static final long RETRY_DELAY_MS = 1_500L;

	private final MockQuizQuestionGenerator fallback;
	private final ObjectMapper objectMapper;
	private final String apiKey;
	private final String model;
	private final RestClient restClient;

	public GeminiQuizQuestionGenerator(
		MockQuizQuestionGenerator fallback,
		ObjectMapper objectMapper,
		@Value("${gemini.api-key:}") String apiKey,
		@Value("${gemini.model:" + DEFAULT_MODEL + "}") String model
	) {
		this.fallback = fallback;
		this.objectMapper = objectMapper;
		this.apiKey = apiKey == null ? "" : apiKey.trim();
		this.model = (model == null || model.isBlank()) ? DEFAULT_MODEL : model.trim();

		SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
		factory.setConnectTimeout(5_000);
		factory.setReadTimeout(30_000); // thinking 모델은 응답이 느릴 수 있다
		this.restClient = RestClient.builder().requestFactory(factory).baseUrl(BASE_URL).build();
	}

	@Override
	public List<GeneratedQuestion> generate(String subjectName, String todayScope) {
		if (apiKey.isEmpty()) {
			log.info("[quiz] gemini.api-key 가 없어 고정 예시 문제로 대체합니다 "
				+ "(환경변수 GEMINI_API_KEY 를 설정하면 Gemini 가 출제합니다)");
			return fallback.generate(subjectName, todayScope);
		}
		for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			try {
				List<GeneratedQuestion> questions = callGemini(todayScope);
				validate(questions);
				log.info("[quiz] Gemini({}) 출제 완료: {}문항 (범위: {})", model, questions.size(), todayScope);
				return questions;
			} catch (HttpClientErrorException e) {
				// 4xx(키·요청 오류)는 재시도해도 소용없다. 바로 폴백.
				log.warn("[quiz] Gemini 요청 거부(4xx) → 고정 예시로 대체: {}", e.getMessage());
				return fallback.generate(subjectName, todayScope);
			} catch (RestClientException e) {
				// 5xx(과부하)·타임아웃·응답 추출 실패 등 일시적 오류 → 재시도.
				log.warn("[quiz] Gemini 호출 실패({}/{}): {}", attempt, MAX_ATTEMPTS, e.getMessage());
				if (attempt < MAX_ATTEMPTS) {
					sleep(RETRY_DELAY_MS * attempt);
				}
			} catch (Exception e) {
				// JSON 파싱·검증 실패 → 재시도 무의미. 폴백.
				log.warn("[quiz] Gemini 응답 처리 실패 → 고정 예시로 대체: {}", e.getMessage());
				return fallback.generate(subjectName, todayScope);
			}
		}
		log.warn("[quiz] Gemini 재시도 {}회 모두 실패 → 고정 예시로 대체", MAX_ATTEMPTS);
		return fallback.generate(subjectName, todayScope);
	}

	private static void sleep(long ms) {
		try {
			Thread.sleep(ms);
		} catch (InterruptedException ie) {
			Thread.currentThread().interrupt();
		}
	}

	private List<GeneratedQuestion> callGemini(String todayScope) throws Exception {
		Map<String, Object> body = Map.of(
			"contents", List.of(Map.of("parts", List.of(Map.of("text", buildPrompt(todayScope))))),
			"generationConfig", Map.of(
				"temperature", 0.7,
				// 퀴즈 출제엔 깊은 추론이 필요 없다. 추론 토큰(비용/지연)을 낮춘다.
				"thinkingConfig", Map.of("thinkingLevel", "low"),
				"responseMimeType", "application/json",
				"responseSchema", responseSchema()
			)
		);

		String raw = restClient.post()
			.uri("/v1beta/models/{model}:generateContent?key={key}", model, apiKey)
			.contentType(MediaType.APPLICATION_JSON)
			.body(body)
			.retrieve()
			.body(String.class);

		if (raw == null || raw.isBlank()) {
			throw new IllegalStateException("Gemini 응답 본문이 비어 있습니다");
		}

		JsonNode root = objectMapper.readTree(raw);
		// thinking 모델은 parts 에 thought 파트가 섞일 수 있어, text 가 있는 첫 파트를 찾는다.
		String generated = null;
		for (JsonNode part : root.path("candidates").path(0).path("content").path("parts")) {
			JsonNode t = part.path("text");
			if (t.isTextual() && !t.asText().isBlank()) {
				generated = t.asText();
				break;
			}
		}
		if (generated == null) {
			throw new IllegalStateException("응답에 생성 텍스트가 없습니다: " + brief(raw));
		}

		JsonNode arr = objectMapper.readTree(generated);
		if (!arr.isArray()) {
			throw new IllegalStateException("생성 결과가 JSON 배열이 아닙니다");
		}
		List<GeneratedQuestion> result = new ArrayList<>();
		for (JsonNode q : arr) {
			result.add(objectMapper.treeToValue(q, GeneratedQuestion.class));
		}
		return result;
	}

	/** 3문항인지, 각 문항의 필드·정답 번호·유형이 정상인지 확인한다. 어긋나면 예외 → 폴백. */
	private void validate(List<GeneratedQuestion> questions) {
		if (questions.size() != REQUIRED_COUNT) {
			throw new IllegalStateException("문항 수가 " + REQUIRED_COUNT + "개가 아닙니다: " + questions.size());
		}
		for (GeneratedQuestion q : questions) {
			if (isBlank(q.questionText()) || isBlank(q.choice1()) || isBlank(q.choice2())
				|| isBlank(q.choice3()) || isBlank(q.choice4()) || isBlank(q.explanation())) {
				throw new IllegalStateException("문항 필드가 비어 있습니다");
			}
			if (q.answerNo() < 1 || q.answerNo() > 4) {
				throw new IllegalStateException("정답 번호가 1~4 밖입니다: " + q.answerNo());
			}
			if (!"BASIC".equals(q.questionType()) && !"APPLIED".equals(q.questionType())) {
				throw new IllegalStateException("questionType 이 BASIC/APPLIED 가 아닙니다: " + q.questionType());
			}
		}
		long applied = questions.stream().filter(q -> "APPLIED".equals(q.questionType())).count();
		if (applied != 1) {
			log.warn("[quiz] APPLIED 문항이 1개가 아닙니다(={}). 그대로 사용합니다.", applied);
		}
	}

	private String buildPrompt(String todayScope) {
		return """
			당신은 학습 퀴즈 출제자입니다. 아래 '오늘 학습 범위'만을 바탕으로 한국어 4지선다 객관식 문제 3개를 만드세요.

			규칙:
			- 1번, 2번 문제는 개념 확인 수준으로 만들고 questionType 을 "BASIC" 으로 합니다.
			- 3번 문제는 배운 내용을 실제 상황에 적용하는 응용 수준으로 만들고 questionType 을 "APPLIED" 로 합니다.
			- 각 문제는 보기 4개(choice1~choice4), 정답 번호(answerNo, 1~4 정수), 한국어 해설(explanation)을 포함합니다.
			- 정답 위치(answerNo)는 문제마다 다양하게 분포시킵니다.
			- 오늘 학습 범위를 벗어나는 내용은 출제하지 않습니다.
			- 화면이 LaTeX/마크다운을 렌더링하지 않으므로, 수식은 "$", "\\", "^{}" 같은 LaTeX
			  문법을 쓰지 말고 일반 텍스트로 풀어 씁니다. 예: "a^x" 대신 "a의 x제곱",
			  "x_1" 대신 "x1", "\\neq" 대신 "≠"처럼 유니코드 기호나 한글 설명으로 대체합니다.
			- 지정된 JSON 스키마(객체 3개짜리 배열)에 맞춰서만 응답합니다.

			오늘 학습 범위: %s
			""".formatted(todayScope);
	}

	/** Gemini 의 responseSchema (OpenAPI 서브셋). GeneratedQuestion 필드와 1:1. */
	private Map<String, Object> responseSchema() {
		Map<String, Object> stringType = Map.of("type", "STRING");

		Map<String, Object> props = new LinkedHashMap<>();
		props.put("questionType", Map.of("type", "STRING", "enum", List.of("BASIC", "APPLIED")));
		props.put("questionText", stringType);
		props.put("choice1", stringType);
		props.put("choice2", stringType);
		props.put("choice3", stringType);
		props.put("choice4", stringType);
		props.put("answerNo", Map.of("type", "INTEGER"));
		props.put("explanation", stringType);

		return Map.of(
			"type", "ARRAY",
			"items", Map.of(
				"type", "OBJECT",
				"properties", props,
				"required", List.of("questionType", "questionText", "choice1", "choice2",
					"choice3", "choice4", "answerNo", "explanation")
			)
		);
	}

	private static boolean isBlank(String s) {
		return s == null || s.isBlank();
	}

	private static String brief(String s) {
		if (s == null) {
			return "(빈 응답)";
		}
		String flat = s.replaceAll("\\s+", " ").trim();
		return flat.length() > 200 ? flat.substring(0, 200) + "…" : flat;
	}
}
