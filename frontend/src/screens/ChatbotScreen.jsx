import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { theme } from '../theme';
import logo from '../assets/logo.png';
import { saveStopwatchAndClear } from '../lib/study-session';

// MainScreen.jsx/MyPageScreen.jsx/StudyStatsScreen.jsx와 같은 백엔드(파이썬,
// 8000번 포트). 챗봇 엔드포인트(server.py의 POST /chat)도 여기서 같이 뜬다.
const API_BASE = 'http://localhost:8000';
const AUTH_API_BASE = 'http://localhost:8081';
// 대화가 길어지면 매번 전체 히스토리를 다 보내는 게 토큰/비용 낭비라서,
// 최근 이만큼만 잘라서 서버로 보낸다 (서버는 그대로 Gemini에 전달만 함).
const MAX_HISTORY_TURNS = 8;

function todayKey() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(
    t.getDate(),
  ).padStart(2, '0')}`;
}

// 메인 캘린더가 들고 있는 plan.days[].items[]를, 챗봇이 참고할 수 있게 짧은
// 한국어 문장으로 요약한다. 백엔드는 이 문자열을 그대로 프롬프트에 끼워 넣을
// 뿐이라, 실제 요약 로직은 전부 여기(프론트)에 있다.
function buildContextSummary(plan) {
  if (!plan?.days?.length) return '';
  const today = todayKey();
  const todayItems = plan.days.find((d) => d.date === today)?.items || [];

  const lines = [`오늘(${today}) 학습 항목:`];
  if (todayItems.length === 0) {
    lines.push('- 오늘 배정된 항목 없음');
  } else {
    todayItems.forEach((item) => {
      lines.push(
        `- ${item.subject ? `[${item.subject}] ` : ''}${item.content} ` +
          `(${item.durationMinutes}분, 진행률 ${item.progressRate}%${
            item.completed ? ', 완료' : ''
          })`,
      );
    });
  }

  const totalItems = plan.days.reduce((sum, d) => sum + d.items.length, 0);
  const totalDays = plan.days.length;
  lines.push(`전체 계획: 총 ${totalItems}개 항목, ${totalDays}일에 걸쳐 배정됨.`);
  return lines.join('\n');
}

const page = {
  minHeight: '100vh',
  background: theme.colors.bg,
  fontFamily: theme.font,
  color: theme.colors.text,
};
const topbar = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '16px 28px',
  background: '#fff',
  borderBottom: `1px solid ${theme.colors.border}`,
  position: 'sticky',
  top: 0,
  zIndex: 10,
};
const hamburgerBtn = {
  position: 'fixed',
  top: 64,
  left: 28,
  zIndex: 9,
  border: 'none',
  background: 'transparent',
  fontSize: 20,
  cursor: 'pointer',
  color: theme.colors.text,
  padding: 4,
};
const sidebarOverlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.25)',
  zIndex: 19,
};
const sidebarPanel = {
  position: 'fixed',
  top: 0,
  left: 0,
  bottom: 0,
  width: 240,
  background: '#fff',
  borderRight: `1px solid ${theme.colors.border}`,
  boxShadow: theme.shadow,
  zIndex: 20,
  padding: '20px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};
const sidebarItem = {
  padding: '10px 12px',
  borderRadius: theme.radius.sm || 8,
  fontSize: 14,
  fontWeight: 600,
  color: theme.colors.text,
  cursor: 'pointer',
};
const sidebarDivider = {
  height: 1,
  background: theme.colors.border,
  margin: '8px 0',
};
const chatWrap = {
  width: 720,
  maxWidth: 'calc(100% - 40px)',
  margin: '28px auto',
  background: '#fff',
  border: `1px solid ${theme.colors.border}`,
  borderRadius: theme.radius.lg,
  boxShadow: theme.shadow,
  display: 'flex',
  flexDirection: 'column',
  height: 'calc(100vh - 120px)',
};
const chatHeader = {
  padding: '16px 20px',
  borderBottom: `1px solid ${theme.colors.border}`,
};
const messageList = {
  flex: 1,
  overflowY: 'auto',
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};
function bubble(role) {
  const isUser = role === 'user';
  return {
    alignSelf: isUser ? 'flex-end' : 'flex-start',
    maxWidth: '80%',
    background: isUser ? theme.colors.primary : theme.colors.primarySoft,
    color: isUser ? '#fff' : theme.colors.text,
    borderRadius: 14,
    padding: '10px 14px',
    fontSize: 14,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
  };
}
const inputRow = {
  display: 'flex',
  gap: 8,
  padding: 16,
  borderTop: `1px solid ${theme.colors.border}`,
};
const textInput = {
  flex: 1,
  fontFamily: theme.font,
  border: `1px solid ${theme.colors.border}`,
  borderRadius: theme.radius.pill,
  padding: '10px 16px',
  fontSize: 14,
  outline: 'none',
};
function sendBtn(disabled) {
  return {
    fontFamily: theme.font,
    background: disabled ? theme.colors.disabled : theme.colors.primary,
    color: '#fff',
    border: 'none',
    borderRadius: theme.radius.pill,
    padding: '0 20px',
    fontSize: 14,
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

function Sidebar({ open, onClose, navigate, handleLogout }) {
  if (!open) return null;
  return (
    <>
      <div style={sidebarOverlay} onClick={onClose} />
      <div style={sidebarPanel}>
        <img
          src={logo}
          alt="Planit"
          style={{ height: 24, width: 'auto', alignSelf: 'flex-start', marginBottom: 12 }}
        />
        <span
          style={sidebarItem}
          onClick={() => {
            onClose();
            navigate('/mypage');
          }}
        >
          마이페이지
        </span>
        <span
          style={sidebarItem}
          onClick={() => {
            onClose();
            navigate('/study-stats');
          }}
        >
          학습 통계
        </span>
        <span
          style={{ ...sidebarItem, color: theme.colors.primaryDark }}
          onClick={() => {
            onClose();
            navigate('/chatbot');
          }}
        >
          챗봇
        </span>
        <div style={sidebarDivider} />
        <span
          style={sidebarItem}
          onClick={() => {
            onClose();
            handleLogout();
          }}
        >
          로그아웃
        </span>
      </div>
    </>
  );
}

const WELCOME_MESSAGE = {
  role: 'model',
  text: '안녕하세요! Planit 학습 도우미예요. 오늘 할 일이나 공부 계획에 대해 뭐든 물어보세요.',
};

export default function ChatbotScreen() {
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [plan, setPlan] = useState(null);
  const userId = localStorage.getItem('userId') || 'guest';
  // 페이지 이동/새로고침해도 대화가 안 사라지게 sessionStorage에 들고 있는다
  // (탭을 닫으면 사라짐 - 서버 어딘가에 영구 저장할 정도의 기능은 아니라서 이 정도면 충분).
  const chatStorageKey = `planit_chat_${userId}`;
  const [messages, setMessages] = useState(() => {
    try {
      const raw = sessionStorage.getItem(chatStorageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : [WELCOME_MESSAGE];
    } catch {
      return [WELCOME_MESSAGE];
    }
  });
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  // null이면 아직 조회 전(로딩 중) - 무료 티어 하루 한도라 실제로 몇 번 남았는지
  // 채팅창 열자마자 보여줘야 사용자가 헛되이 입력하다 막히지 않는다.
  const [quota, setQuota] = useState(null);
  const listEndRef = useRef(null);

  const contextSummary = useMemo(() => buildContextSummary(plan), [plan]);

  useEffect(() => {
    try {
      sessionStorage.setItem(chatStorageKey, JSON.stringify(messages));
    } catch {
      // sessionStorage를 못 쓰는 환경이면 그냥 이번 렌더 동안만 메모리로 유지한다.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  useEffect(() => {
    fetch(`${API_BASE}/plans/${userId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setPlan(data))
      .catch(() => setPlan(null));
  }, [userId]);

  useEffect(() => {
    fetch(`${API_BASE}/chat/quota`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setQuota(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleLogout = async () => {
    await saveStopwatchAndClear(userId);
    try {
      await fetch(`${AUTH_API_BASE}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // 로그아웃 요청이 실패해도 로컬 로그인 상태는 지워서 화면은 로그인 화면으로 보낸다.
    }
    localStorage.removeItem('userId');
    window.location.href = '/';
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending || quotaExhausted) return;

    const nextMessages = [...messages, { role: 'user', text }];
    setMessages(nextMessages);
    setInput('');
    setError('');
    setSending(true);

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          // 방금 보낸 사용자 메시지 앞까지만, 최근 몇 턴만 히스토리로 같이 보낸다.
          history: nextMessages.slice(0, -1).slice(-MAX_HISTORY_TURNS),
          context: contextSummary,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || '챗봇 응답을 받지 못했습니다.');
      setMessages((cur) => [...cur, { role: 'model', text: data.reply }]);
      if (typeof data.remaining === 'number') {
        setQuota({ remaining: data.remaining, dailyLimit: data.dailyLimit });
      }
    } catch (e) {
      setError(e.message);
      // 실패한 사용자 메시지는 화면엔 남겨두되(재입력 번거로움 방지), 에러만 따로 보여준다.
    } finally {
      setSending(false);
    }
  };

  const quotaExhausted = quota && quota.remaining <= 0;

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={page}>
      <div style={topbar}>
        <img
          src={logo}
          alt="Planit"
          style={{ height: 28, cursor: 'pointer' }}
          onClick={() => navigate('/main')}
        />
      </div>
      <button style={hamburgerBtn} title="메뉴" onClick={() => setSidebarOpen(true)}>
        ☰
      </button>
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        navigate={navigate}
        handleLogout={handleLogout}
      />

      <div style={chatWrap}>
        <div style={{ ...chatHeader, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <strong style={{ fontSize: 16 }}>학습 도우미 챗봇</strong>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: theme.colors.textSoft }}>
              오늘 할 일과 계획 데이터를 참고해서 답해드려요.
            </p>
          </div>
          {quota && (
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: quotaExhausted ? theme.colors.danger : theme.colors.primaryDark,
                whiteSpace: 'nowrap',
              }}
            >
              오늘 {quota.remaining}/{quota.dailyLimit}회 남음
            </span>
          )}
        </div>

        <div style={messageList}>
          {messages.map((m, i) => (
            <div key={i} style={bubble(m.role)}>
              {m.text}
            </div>
          ))}
          {sending && (
            <div style={{ ...bubble('model'), color: theme.colors.textSoft }}>
              입력 중...
            </div>
          )}
          <div ref={listEndRef} />
        </div>

        {error && (
          <p
            style={{
              color: theme.colors.danger,
              fontSize: 13,
              fontWeight: 600,
              margin: '0 16px',
            }}
          >
            {error}
          </p>
        )}

        <div style={inputRow}>
          <input
            style={textInput}
            placeholder={quotaExhausted ? '오늘 사용 한도를 다 썼어요' : '메시지를 입력하세요'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending || quotaExhausted}
          />
          <button
            style={sendBtn(sending || quotaExhausted || !input.trim())}
            onClick={handleSend}
            disabled={sending || quotaExhausted || !input.trim()}
          >
            전송
          </button>
        </div>
      </div>
    </div>
  );
}
