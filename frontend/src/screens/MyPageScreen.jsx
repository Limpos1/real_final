import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './MyPageScreen.css';
import { auth } from '../firebase';
import { db } from '../firebase';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { updateProfile, sendPasswordResetEmail } from 'firebase/auth';
import { saveStopwatchAndClear } from '../lib/study-session';

// =========================================================================
// 회원정보 전용 마이페이지 (mypage_mockup.html을 React로 옮긴 버전).
// "학습 통계"(StudyStatsScreen.jsx)와는 완전히 별개 화면.
// 이름만 수정 가능, 이메일은 읽기 전용.
//
// AUTH_API_BASE: 로그인 백엔드(김동호) 포트. 8081.
// (탈퇴/로그아웃 둘 다 이 백엔드의 /api/auth/* 라우트를 쓴다. 8080은
//  체크리스트 백엔드라 /api/auth 라우트가 없어 8080으로 보내면 404가 난다.)
//
// 프로필 사진 업로드 기능은 제거했다 (Firebase Storage는 유료 Blaze 요금제
// 전환이 필요한데 프로젝트 소유자만 할 수 있고, 자체 서버 저장 방식은 같은
// 와이파이에서만 동작하는 한계가 있어서 - 팀 판단으로 기능 자체를 뺐다).
// 아바타는 이름 첫 글자만 보여준다.
// =========================================================================
const AUTH_API_BASE = 'http://localhost:8081';

// MainScreen.jsx/StudyStatsScreen.jsx와 동일한 상단바 + 햄버거 메뉴
// (fallback 색상은 StudyStatsScreen.css :root 값과 동일 - 이 화면 CSS엔
//  그 변수가 정의돼 있지 않아서, 다른 화면을 안 거치고 바로 /mypage로
//  들어와도 깨지지 않게 기본값을 같이 적어둔다.)
const topbar = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '16px 28px',
  background: '#fff',
  borderBottom: '1px solid var(--line, #F7DCE0)',
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
  color: 'var(--ink, #4B3B47)',
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
  borderRight: '1px solid var(--line, #F7DCE0)',
  boxShadow: '0 12px 28px -14px rgba(169,143,194,0.35)',
  zIndex: 20,
  padding: '20px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};
const sidebarItem = {
  padding: '10px 12px',
  borderRadius: 10,
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--ink, #4B3B47)',
  cursor: 'pointer',
};
const sidebarDivider = {
  height: 1,
  background: 'var(--line, #F7DCE0)',
  margin: '8px 0',
};

const Icon = {
  user: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
      <circle cx="12" cy="7" r="4"></circle>
    </svg>
  ),
  mail: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="4" width="20" height="16" rx="2"></rect>
      <path d="m2 7 10 6 10-6"></path>
    </svg>
  ),
  lock: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="11" width="18" height="11" rx="2"></rect>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    </svg>
  ),
  trash: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 11v6"></path>
      <path d="M14 11v6"></path>
      <path d="M4 7h16"></path>
      <path d="M6 7V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v3"></path>
      <path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"></path>
    </svg>
  ),
};

export default function MyPageScreen() {
  const navigate = useNavigate();
  const [memberId] = useState(() => localStorage.getItem('userId'));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    if (!memberId) return;
    (async () => {
      const snap = await getDoc(doc(db, 'users', memberId));
      if (snap.exists()) {
        setName(snap.data().name || '');
        setEmail(snap.data().email || '');
      }
      setLoading(false);
    })();
  }, [memberId]);

  const handleEditName = async () => {
    const newName = window.prompt('새 이름을 입력하세요', name);
    if (!newName || newName.trim() === '') return;
    try {
      await updateDoc(doc(db, 'users', memberId), { name: newName.trim() });
      if (auth.currentUser)
        await updateProfile(auth.currentUser, { displayName: newName.trim() });
      setName(newName.trim());
      setMsg({ type: 'ok', text: '이름이 변경됐어요.' });
    } catch (e) {
      setMsg({ type: 'err', text: '이름 변경에 실패했어요: ' + e.message });
    }
  };

  const handleResetPassword = async () => {
    if (!email)
      return setMsg({ type: 'err', text: '이메일 정보를 불러오지 못했어요.' });
    try {
      await sendPasswordResetEmail(auth, email);
      setMsg({
        type: 'ok',
        text: `${email}로 비밀번호 재설정 메일을 보냈어요.`,
      });
    } catch (e) {
      setMsg({ type: 'err', text: '메일 발송에 실패했어요: ' + e.message });
    }
  };

  const handleWithdraw = async () => {
    if (
      !window.confirm(
        '정말 탈퇴하시겠습니까?\n계정과 학습 데이터가 모두 삭제되며 되돌릴 수 없습니다.',
      )
    )
      return;
    try {
      const res = await fetch(`${AUTH_API_BASE}/api/auth/withdraw`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body && body.message) || `요청 실패 (${res.status})`);
      }
      localStorage.removeItem('userId');
      window.location.href = '/';
    } catch (e) {
      setMsg({
        type: 'err',
        text: '탈퇴 처리 중 오류가 발생했어요: ' + e.message,
      });
    }
  };

  // MainScreen.jsx/StudyStatsScreen.jsx의 로그아웃과 동일한 로직
  const handleLogout = async () => {
    await saveStopwatchAndClear(localStorage.getItem('userId') || 'guest');
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

  if (!memberId) {
    return (
      <div className="mypage-root">
        <p>로그인이 필요해요.</p>
      </div>
    );
  }
  if (loading) {
    return <div className="mypage-root"></div>;
  }

  return (
    <div className="mypage-root">
      <div style={topbar}>
        <img
          src="/wordmark.png"
          alt="Planit"
          style={{ height: 28, cursor: 'pointer' }}
          onClick={() => navigate('/main')}
        />
      </div>
      <button
        style={hamburgerBtn}
        title="메뉴"
        onClick={() => setSidebarOpen(true)}
      >
        ☰
      </button>
      {sidebarOpen && (
        <>
          <div style={sidebarOverlay} onClick={() => setSidebarOpen(false)} />
          <div style={sidebarPanel}>
            <img
              src="/wordmark.png"
              alt="Planit"
              style={{
                height: 24,
                width: 'auto',
                alignSelf: 'flex-start',
                marginBottom: 12,
              }}
            />
            <span
              style={sidebarItem}
              onClick={() => {
                setSidebarOpen(false);
                navigate('/mypage');
              }}
            >
              마이페이지
            </span>
            <span
              style={sidebarItem}
              onClick={() => {
                setSidebarOpen(false);
                navigate('/study-stats');
              }}
            >
              학습 통계
            </span>
            <span
              style={sidebarItem}
              onClick={() => {
                setSidebarOpen(false);
                navigate('/chatbot');
              }}
            >
              챗봇
            </span>
            <div style={sidebarDivider} />
            <span
              style={sidebarItem}
              onClick={() => {
                setSidebarOpen(false);
                handleLogout();
              }}
            >
              로그아웃
            </span>
          </div>
        </>
      )}

      <div className="mypage-page">
        <div className="mypage-layout">
          <aside className="mypage-sidebar">
            <div className="mypage-avatar">{name ? name.slice(0, 1) : 'P'}</div>
            <div className="mypage-side-name">{name || '회원'}</div>
            <div className="mypage-side-email">{email}</div>
          </aside>

          <div className="mypage-content">
            {msg && <p className={`mypage-msg ${msg.type}`}>{msg.text}</p>}

            <section className="mypage-card" id="profile-card">
              <div className="mypage-card-header">회원 프로필</div>
              <div className="mypage-card-body">
                <div className="mypage-row">
                  <div className="mypage-row-label">
                    <div className="mypage-row-icon">{Icon.user}</div>
                    <div className="mypage-row-text">
                      <div className="t">이름</div>
                      <div className="d">{name}</div>
                    </div>
                  </div>
                  <button
                    className="mypage-btn mypage-btn-ghost"
                    onClick={handleEditName}
                  >
                    수정
                  </button>
                </div>
                <div className="mypage-row">
                  <div className="mypage-row-label">
                    <div className="mypage-row-icon">{Icon.mail}</div>
                    <div className="mypage-row-text">
                      <div className="t">이메일</div>
                      <div className="d">{email}</div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="mypage-card" id="account-card">
              <div className="mypage-card-header">계정 관리</div>
              <div className="mypage-card-body">
                <div className="mypage-row">
                  <div className="mypage-row-label">
                    <div className="mypage-row-icon">{Icon.lock}</div>
                    <div className="mypage-row-text">
                      <div className="t">비밀번호 변경</div>
                      <div className="d">이메일로 재설정 링크를 보내드려요</div>
                    </div>
                  </div>
                  <button
                    className="mypage-btn mypage-btn-primary"
                    onClick={handleResetPassword}
                  >
                    변경
                  </button>
                </div>
                <div className="mypage-row mypage-danger-row">
                  <div className="mypage-row-label">
                    <div className="mypage-row-icon">{Icon.trash}</div>
                    <div className="mypage-row-text">
                      <div className="t">회원 탈퇴</div>
                      <div className="d">
                        탈퇴 시 모든 학습 데이터가 삭제되고 복구할 수 없어요
                      </div>
                    </div>
                  </div>
                  <button
                    className="mypage-btn mypage-btn-danger"
                    onClick={handleWithdraw}
                  >
                    탈퇴하기
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

    </div>
  );
}
