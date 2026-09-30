package com.planit.quiz;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;

import org.springframework.stereotype.Service;

import com.google.cloud.firestore.DocumentReference;
import com.google.cloud.firestore.DocumentSnapshot;
import com.google.cloud.firestore.Firestore;
import com.google.cloud.firestore.QueryDocumentSnapshot;
import com.google.firebase.FirebaseApp;
import com.google.firebase.cloud.FirestoreClient;
import com.planit.global.ApiException;
import com.planit.quiz.QuizDtos.QuestionView;
import com.planit.quiz.QuizDtos.StartResponse;
import com.planit.quiz.QuizDtos.SubmitResponse;
import com.planit.quiz.QuizDtos.SummaryResponse;
import com.planit.quiz.QuizDtos.TodayPlanItem;
import com.planit.quiz.QuizDtos.TodayPlanResponse;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

/**
 * 퀴즈봇 (REQ-Q-001 ~ REQ-Q-006). 방식 B: 저장소는 Firestore 이고, 접근은 전부 여기(Spring)를 거친다.
 * 브라우저는 Firestore 를 직접 건드리지 않는다.
 *
 * 오늘의 일과는 파이썬 플랜 파이프라인(checklist_sync.py)이 쓰는 "study_plan_items"
 * 컬렉션을 그대로 읽는다 - memberId(=uid)와 오늘 날짜(planDate)로 조회.
 *
 * Firestore 구조:
 *   study_plans/{planId}                  { source: "pdf"|"image", parsedToc, ... } (파이썬이 씀)
 *   study_plan_items/{itemId}             { memberId, studyPlanId, planDate, content, progressRate, ... } (파이썬이 씀)
 *   quizzes/{quizId}                      { uid, subjectName, todayScope, quizDate, createdAt, questions[] }
 *   quizzes/{quizId}/answers/{questionNo} { selectedChoice, correct, answeredAt }
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class QuizService {

	/** 퀴즈 출제 범위에 넣을 최소 진행률(%). 이 값 이상인 항목만 출제 대상 (REQ-Q-003). */
	private static final int QUIZ_SCOPE_MIN_PROGRESS = 75;

	private final QuizQuestionGenerator questionGenerator;

	/** 파이썬 study_plan_id_for_user()와 동일한 규칙. */
	private static String studyPlanIdFor(String uid) {
		return "plan-" + uid;
	}

	/**
	 * 퀴즈봇은 PDF로 만든 플랜에서만 연다. 사진(vision)으로 읽은 페이지 번호는 PDF
	 * 텍스트 추출만큼 정확하다고 보장할 수 없어서, 틀린 범위로 문제를 내는 것보다
	 * 아예 막는 쪽을 택했다. study_plans/{planId}.source 가 "pdf"가 아니면(사진으로
	 * 만들었거나, 아직 플랜을 안 만들었거나) 막는다.
	 */
	private void requirePdfSource(String uid) {
		DocumentSnapshot planDoc;
		try {
			planDoc = db().collection("study_plans").document(studyPlanIdFor(uid)).get().get();
		} catch (ExecutionException | InterruptedException e) {
			throw ApiException.notFound("학습 플랜을 확인할 수 없습니다");
		}
		String source = planDoc.exists() ? planDoc.getString("source") : null;
		if (!"pdf".equals(source)) {
			throw ApiException.forbidden(
				"사진으로 만든 계획은 페이지 범위가 정확하지 않아 퀴즈를 만들 수 없습니다. "
					+ "PDF로 계획을 다시 만들어주세요.");
		}
	}

	/** 로그인 사용자의 오늘(study_plan_items) 항목을 읽어 화면 표시용 목록과 출제 범위 문자열을 만든다. */
	public TodayPlanResponse todayPlan(String uid) {
		requirePdfSource(uid);

		String today = LocalDate.now().toString();
		List<QueryDocumentSnapshot> docs;
		try {
			docs = db().collection("study_plan_items")
				.whereEqualTo("memberId", uid)
				.whereEqualTo("planDate", today)
				.get().get().getDocuments();
		} catch (ExecutionException | InterruptedException e) {
			throw ApiException.notFound("오늘의 학습 항목을 불러오지 못했습니다");
		}
		// PDF+사진을 섞어 올린 플랜이어도 사진 쪽 항목은 페이지 범위를 신뢰할 수 없으니
		// 퀴즈 범위에서 아예 뺀다 - requirePdfSource()는 "PDF가 하나라도 있는지"만
		// 보므로, 오늘 항목 중 실제로 PDF에서 온 것만 여기서 다시 걸러야 한다.
		List<QueryDocumentSnapshot> pdfDocs = new ArrayList<>();
		for (QueryDocumentSnapshot doc : docs) {
			if ("pdf".equals(doc.getString("source"))) {
				pdfDocs.add(doc);
			}
		}
		docs = pdfDocs;
		if (docs.isEmpty()) {
			throw ApiException.notFound("오늘 학습 항목이 없습니다");
		}
		docs.sort((a, b) -> Integer.compare(
			a.contains("sortOrder") ? a.getLong("sortOrder").intValue() : 0,
			b.contains("sortOrder") ? b.getLong("sortOrder").intValue() : 0));

		List<TodayPlanItem> items = new ArrayList<>();
		List<String> allParts = new ArrayList<>();
		List<String> quizParts = new ArrayList<>();
		int totalMinutes = 0;
		for (QueryDocumentSnapshot doc : docs) {
			String content = doc.getString("content");
			int progressRate = doc.contains("progressRate") ? doc.getLong("progressRate").intValue() : 0;
			boolean inQuizScope = progressRate >= QUIZ_SCOPE_MIN_PROGRESS;
			totalMinutes += doc.contains("durationMinutes") && doc.getLong("durationMinutes") != null
				? doc.getLong("durationMinutes").intValue() : 0;

			items.add(new TodayPlanItem(content, progressRate, inQuizScope));
			allParts.add(content);
			if (inQuizScope) {
				quizParts.add(content);
			}
		}

		// 75% 이상 진행된 항목만 출제. 하나도 없으면 오늘 전체 범위로 폴백(퀴즈봇은 항상 동작).
		List<String> scopeParts = quizParts.isEmpty() ? allParts : quizParts;
		if (quizParts.isEmpty()) {
			log.warn("[quiz] uid={} 진행률 {}% 이상인 항목이 없어 오늘 전체 범위로 출제합니다", uid, QUIZ_SCOPE_MIN_PROGRESS);
		}

		return new TodayPlanResponse(today, totalMinutes, items, String.join(", ", scopeParts));
	}

	/** REQ-Q-001 ~ REQ-Q-003: 오늘 학습 범위로 퀴즈 1세트 생성 → Firestore 저장. 정답/풀이는 응답에서 뺀다. */
	public StartResponse start(String uid) throws Exception {
		TodayPlanResponse plan = todayPlan(uid);
		List<GeneratedQuestion> generated = questionGenerator.generate("quiz", plan.scope());

		List<Map<String, Object>> questionDocs = new ArrayList<>();
		int no = 1;
		for (GeneratedQuestion g : generated) {
			Map<String, Object> q = new LinkedHashMap<>();
			q.put("questionNo", no++);
			q.put("questionType", g.questionType());
			q.put("questionText", g.questionText());
			q.put("choice1", g.choice1());
			q.put("choice2", g.choice2());
			q.put("choice3", g.choice3());
			q.put("choice4", g.choice4());
			q.put("answerNo", g.answerNo());
			q.put("explanation", g.explanation());
			questionDocs.add(q);
		}

		Map<String, Object> quizDoc = new LinkedHashMap<>();
		quizDoc.put("uid", uid);
		quizDoc.put("subjectName", "quiz");
		quizDoc.put("todayScope", plan.scope());
		quizDoc.put("quizDate", LocalDate.now().toString());
		quizDoc.put("createdAt", com.google.cloud.firestore.FieldValue.serverTimestamp());
		quizDoc.put("questions", questionDocs);

		DocumentReference ref = db().collection("quizzes").document();
		ref.set(quizDoc).get();

		List<QuestionView> views = new ArrayList<>();
		for (Map<String, Object> q : questionDocs) {
			views.add(new QuestionView(
				(int) q.get("questionNo"),
				(String) q.get("questionType"),
				(String) q.get("questionText"),
				(String) q.get("choice1"),
				(String) q.get("choice2"),
				(String) q.get("choice3"),
				(String) q.get("choice4")
			));
		}
		return new StartResponse(ref.getId(), views);
	}

	/** REQ-Q-004, REQ-Q-005: 문제 하나 제출 → 채점 결과와 풀이. 문제당 1회만. */
	public SubmitResponse submit(String uid, String quizId, int questionNo, Integer selectedChoice)
		throws Exception {
		if (selectedChoice == null || selectedChoice < 1 || selectedChoice > 4) {
			throw ApiException.badRequest("보기 번호는 1~4 중 하나여야 합니다");
		}

		DocumentReference quizRef = db().collection("quizzes").document(quizId);
		DocumentSnapshot quizSnap = quizRef.get().get();
		requireOwnedQuiz(quizSnap, uid);

		Map<String, Object> question = findQuestion(quizSnap, questionNo);
		if (question == null) {
			throw ApiException.notFound("퀴즈 문제를 찾을 수 없습니다");
		}

		DocumentReference answerRef = quizRef.collection("answers").document(String.valueOf(questionNo));
		if (answerRef.get().get().exists()) {
			throw ApiException.conflict("이미 제출한 문제입니다");
		}

		int answerNo = ((Number) question.get("answerNo")).intValue();
		String explanation = (String) question.get("explanation");
		boolean correct = selectedChoice == answerNo;

		Map<String, Object> answerDoc = new LinkedHashMap<>();
		answerDoc.put("selectedChoice", selectedChoice);
		answerDoc.put("correct", correct);
		answerDoc.put("answeredAt", com.google.cloud.firestore.FieldValue.serverTimestamp());
		answerRef.set(answerDoc).get();

		return new SubmitResponse(questionNo, correct, answerNo, explanation);
	}

	/** REQ-Q-006: 제출한 답안을 모아 맞힌 개수 요약. */
	public SummaryResponse summary(String uid, String quizId) throws Exception {
		DocumentReference quizRef = db().collection("quizzes").document(quizId);
		DocumentSnapshot quizSnap = quizRef.get().get();
		requireOwnedQuiz(quizSnap, uid);

		int total = questionsOf(quizSnap).size();

		List<QueryDocumentSnapshot> answers = quizRef.collection("answers").get().get().getDocuments();
		int correct = 0;
		for (QueryDocumentSnapshot a : answers) {
			if (Boolean.TRUE.equals(a.getBoolean("correct"))) {
				correct++;
			}
		}
		return new SummaryResponse(quizId, total, answers.size(), correct);
	}

	/** 계정 탈퇴 시 해당 사용자의 퀴즈 데이터(quizzes 및 answers 서브컬렉션)를 모두 삭제한다. */
	public void deleteAllForUser(String uid) throws Exception {
		List<QueryDocumentSnapshot> quizzes =
			db().collection("quizzes").whereEqualTo("uid", uid).get().get().getDocuments();
		for (QueryDocumentSnapshot quiz : quizzes) {
			DocumentReference quizRef = quiz.getReference();
			for (DocumentReference answer : quizRef.collection("answers").listDocuments()) {
				answer.delete().get();
			}
			quizRef.delete().get();
		}
		log.info("[withdraw] uid={} 퀴즈 {}건 삭제", uid, quizzes.size());
	}

	// ---- 내부 헬퍼 ----

	private Firestore db() {
		if (FirebaseApp.getApps().isEmpty()) {
			throw ApiException.serviceUnavailable(
				"서버에 Firebase 서비스 계정 키가 없습니다. "
					+ "backend/src/main/resources/firebase-service-account.json 을 두고 서버를 재시작하세요.");
		}
		return FirestoreClient.getFirestore();
	}

	private void requireOwnedQuiz(DocumentSnapshot quizSnap, String uid) {
		if (!quizSnap.exists()) {
			throw ApiException.notFound("퀴즈를 찾을 수 없습니다");
		}
		if (!uid.equals(quizSnap.getString("uid"))) {
			throw ApiException.forbidden("본인의 퀴즈만 응시할 수 있습니다");
		}
	}

	@SuppressWarnings("unchecked")
	private List<Map<String, Object>> questionsOf(DocumentSnapshot quizSnap) {
		Object raw = quizSnap.get("questions");
		return raw instanceof List ? (List<Map<String, Object>>) raw : List.of();
	}

	private Map<String, Object> findQuestion(DocumentSnapshot quizSnap, int questionNo) {
		for (Map<String, Object> q : questionsOf(quizSnap)) {
			if (((Number) q.get("questionNo")).intValue() == questionNo) {
				return q;
			}
		}
		return null;
	}
}
