import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { s, theme } from "../theme";
import logo from "../assets/logo.png";

// 퀴즈봇 API는 로그인 백엔드(Planit-Web-Auth-Plan-Quiz, 8081번 포트)가 갖고 있다.
// 세션 쿠키로 인증하므로 credentials: 'include'가 필수 - 로그인할 때 이미
// 이 오리진에 쿠키가 심어져 있어서 별도 로그인 없이 바로 호출된다.
const AUTH_API_BASE = "http://localhost:8081";

async function api(path, options) {
  const res = await fetch(`${AUTH_API_BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((body && body.message) || `요청 실패 (${res.status})`);
  }
  return body;
}

export default function QuizScreen() {
  const navigate = useNavigate();
  const [plan, setPlan] = useState(null);
  const [planError, setPlanError] = useState("");
  const [quiz, setQuiz] = useState(null); // { quizId, questions }
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  // questionNo -> { selectedChoice, correct, answerNo, explanation }
  const [answers, setAnswers] = useState({});
  const [summary, setSummary] = useState(null);

  const loadPlan = () => {
    setPlanError("");
    api("/api/quizzes/today-plan")
      .then(setPlan)
      .catch((e) => setPlanError(e.message));
  };

  useEffect(loadPlan, []);

  const handleStart = async () => {
    setStarting(true);
    setStartError("");
    try {
      const res = await api("/api/quizzes", { method: "POST", body: "{}" });
      setQuiz(res);
      setAnswers({});
      setSummary(null);
    } catch (e) {
      setStartError(e.message);
    } finally {
      setStarting(false);
    }
  };

  const handleChoose = async (questionNo, choice) => {
    try {
      const res = await api(
        `/api/quizzes/${quiz.quizId}/answers/${questionNo}`,
        { method: "POST", body: JSON.stringify({ selectedChoice: choice }) },
      );
      const next = { ...answers, [questionNo]: { selectedChoice: choice, ...res } };
      setAnswers(next);
      if (Object.keys(next).length === quiz.questions.length) {
        const s2 = await api(`/api/quizzes/${quiz.quizId}/summary`);
        setSummary(s2);
      }
    } catch (e) {
      setStartError(e.message);
    }
  };

  return (
    <div style={{ ...s.page, maxWidth: 720, padding: "0 20px 60px" }}>
      <div style={s.header}>
        <img src={logo} alt="Planit" style={s.logoImg} />
      </div>

      <span style={s.tag}>🧠 퀴즈봇</span>
      <h2 style={{ ...s.title, margin: "0 0 20px" }}>오늘의 퀴즈</h2>

      {planError ? (
        <div style={s.card}>
          <p style={s.errorText}>{planError}</p>
        </div>
      ) : quiz ? (
        startError && <p style={s.errorText}>{startError}</p>
      ) : (
      <div style={s.card}>
        {!plan ? (
          <p style={{ color: theme.colors.textSoft, fontSize: 14 }}>불러오는 중...</p>
        ) : (
          <>
            <p style={{ margin: "0 0 12px", fontWeight: 700 }}>
              {plan.date} · {plan.minutes}분
            </p>
            <ul style={{ margin: "0 0 16px", paddingLeft: 18 }}>
              {plan.items.map((it, i) => (
                <li key={i} style={{ marginBottom: 6, fontSize: 14 }}>
                  {it.content}
                </li>
              ))}
            </ul>
            <button onClick={handleStart} disabled={starting} style={s.btnPrimary(starting)}>
              {starting ? "문제 만드는 중..." : "퀴즈 시작"}
            </button>
            {startError && <p style={s.errorText}>{startError}</p>}
          </>
        )}
      </div>
      )}

      {quiz && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 20 }}>
          {quiz.questions.map((q) => {
            const answered = answers[q.questionNo];
            const applied = q.questionType === "APPLIED";
            return (
              <div key={q.questionNo} style={s.card}>
                <span style={{ ...s.tag, marginBottom: 10 }}>
                  {applied ? "응용" : "기본"} · {q.questionNo}/{quiz.questions.length}
                </span>
                <p style={{ fontWeight: 700, margin: "10px 0" }}>{q.questionText}</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {[q.choice1, q.choice2, q.choice3, q.choice4].map((c, i) => {
                    const no = i + 1;
                    const isAnswer = answered && no === answered.answerNo;
                    const isPicked = answered && no === answered.selectedChoice;
                    return (
                      <button
                        key={no}
                        disabled={!!answered}
                        onClick={() => handleChoose(q.questionNo, no)}
                        style={{
                          ...s.btnSecondary,
                          textAlign: "left",
                          borderColor: isAnswer
                            ? theme.colors.success
                            : isPicked
                              ? theme.colors.danger
                              : theme.colors.border,
                          color: isAnswer || isPicked ? theme.colors.text : theme.colors.text,
                          cursor: answered ? "default" : "pointer",
                        }}
                      >
                        {no}. {c}
                      </button>
                    );
                  })}
                </div>
                {answered && (
                  <p style={{ marginTop: 10, fontSize: 13, color: theme.colors.textSoft }}>
                    {answered.correct ? "⭕ 정답이에요!" : `❌ 오답이에요. 정답은 ${answered.answerNo}번입니다.`}
                    <br />
                    {answered.explanation}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {summary && (
        <div style={{ ...s.card, marginTop: 20, textAlign: "center" }}>
          <p style={{ fontSize: 28, fontWeight: 800, margin: "0 0 6px" }}>
            {summary.correctCount} / {summary.totalQuestionCount}
          </p>
          <p style={{ color: theme.colors.textSoft, fontSize: 13, margin: 0 }}>
            {summary.answeredCount}문제 제출 · {summary.correctCount}문제 정답
          </p>
        </div>
      )}

      <div style={s.btnRow}>
        <button onClick={() => navigate("/main")} style={s.btnSecondary}>
          메인으로
        </button>
      </div>
    </div>
  );
}
