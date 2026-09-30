import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './StudyStatsScreen.css';
import { checkAndAwardBadges } from '../lib/badgeChecker';
import { getStudyStatsData } from '../lib/study-stats-data';
import { saveStopwatchAndClear } from '../lib/study-session';
import logo from '../assets/logo.png';

// =========================================================================
// 마이페이지 대시보드 — Planit-Web-Dashboard(vanilla)를 React로 옮긴 버전.
// index.html + render.js + mock-data.js 를 그대로 이식했습니다.
// (구조/클래스명/로직 전부 원본과 동일 — 나중에 mockData 자리만 실제
//  Firestore 조회 결과로 바꾸면 됩니다. radar-metrics.js 참고)
// =========================================================================

function getAchievedTier(badge) {
  const fromEnd = [...badge.tiers]
    .reverse()
    .findIndex((t) => badge.currentValue >= t);
  return fromEnd === -1 ? 0 : badge.tiers.length - fromEnd;
}

// 학습분석 막대그래프 y축.
// 일간(하루 합계, 최대 6시간 안팎)은 0h/1h/3h/5h/6h+ 고정 눈금을 쓴다.
const AXIS_MAX_MINUTES = 360; // 6시간
const DAILY_AXIS_TICKS = [
  { minutes: AXIS_MAX_MINUTES, label: '6h+' },
  { minutes: 300, label: '5h' },
  { minutes: 180, label: '3h' },
  { minutes: 60, label: '1h' },
  { minutes: 0, label: '0h' },
];
// 주간(7일 합계라 6시간을 쉽게 넘김)은 예전처럼 데이터에 맞춰 자동으로 축을 잡는다.
const AXIS_STEP_MINUTES = [
  60, 120, 180, 300, 420, 600, 900, 1200, 1800, 2400, 3000, 3600,
];
function niceAxisMax(rawMax) {
  if (rawMax <= 0) return 60;
  const found = AXIS_STEP_MINUTES.find((step) => step >= rawMax);
  return found ?? Math.ceil(rawMax / 60) * 60;
}
function formatAxisMinutes(minutes) {
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return `${hours}h`;
  return `${Math.round(hours * 2) / 2}h`; // 0.5시간 단위로 반올림
}

function formatGoalMinutes(minutes) {
  if (minutes < 60) return `${minutes}분`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

// MainScreen.jsx의 topbar/사이드바와 똑같은 위치·동작 (색상만 이 화면의
// 라벤더로즈 CSS 변수를 그대로 재사용)
const topbar = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '16px 28px',
  background: '#fff',
  borderBottom: '1px solid var(--line)',
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
  color: 'var(--ink)',
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
  borderRight: '1px solid var(--line)',
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
  color: 'var(--ink)',
  cursor: 'pointer',
};
const sidebarDivider = {
  height: 1,
  background: 'var(--line)',
  margin: '8px 0',
};

// Chart.js를 CDN에서 동적으로 불러옴 (원본 index.html과 동일한 버전)
function useChartJs() {
  const [ready, setReady] = useState(!!window.Chart);
  useEffect(() => {
    if (window.Chart) {
      setReady(true);
      return;
    }
    const script = document.createElement('script');
    script.src =
      'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js';
    script.onload = () => setReady(true);
    document.head.appendChild(script);
  }, []);
  return ready;
}

function RadarCanvas({ metrics }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const chartJsReady = useChartJs();

  useEffect(() => {
    if (!chartJsReady || !canvasRef.current) return;
    if (chartRef.current) chartRef.current.destroy();

    chartRef.current = new window.Chart(canvasRef.current, {
      type: 'radar',
      data: {
        labels: metrics.labels,
        datasets: [
          {
            data: metrics.values,
            backgroundColor: 'rgba(169,143,194,0.18)',
            borderColor: '#A98FC2',
            borderWidth: 2,
            pointBackgroundColor: '#A98FC2',
            pointRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          r: {
            min: 0,
            max: 100,
            ticks: { display: false },
            grid: { color: '#F7DCE0' },
            angleLines: { color: '#F7DCE0' },
            pointLabels: {
              font: { size: 11, family: "'Noto Sans KR'" },
              color: '#4B3B47',
            },
          },
        },
      },
    });

    return () => chartRef.current && chartRef.current.destroy();
  }, [chartJsReady, metrics]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="학습량, 목표달성률, 꾸준함, 계획완주율, AI학습정답률 5개 지표를 보여주는 오각형 레이더차트"
    />
  );
}

export default function StudyStatsScreen() {
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [currentRange, setCurrentRange] = useState('daily');
  const [d, setD] = useState(null); // 실제 데이터 (로딩 끝나면 채워짐)
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // MainScreen.jsx의 handleLogout과 동일한 로직
  const handleLogout = async () => {
    await saveStopwatchAndClear(localStorage.getItem('userId') || 'guest');
    try {
      await fetch('http://localhost:8081/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // 로그아웃 요청이 실패해도 로컬 로그인 상태는 지워서 화면은 로그인 화면으로 보낸다.
    }
    localStorage.removeItem('userId');
    window.location.href = '/';
  };

  useEffect(() => {
    const memberId = localStorage.getItem('userId');
    if (!memberId) {
      setLoadError('로그인이 필요해요.');
      setLoading(false);
      return;
    }

    (async () => {
      try {
        await checkAndAwardBadges(memberId); // 뱃지 먼저 판정
        const data = await getStudyStatsData(memberId);
        setD(data);
      } catch (e) {
        console.error(e);
        setLoadError('데이터를 불러오는 중 문제가 생겼어요.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="mypage2"></div>;
  if (loadError || !d)
    return (
      <div className="mypage2">
        <p style={{ padding: 32, color: '#C0574B' }}>{loadError}</p>
      </div>
    );

  const a = d.analysis[currentRange];

  const diff = a.periodActualMinutes - a.comparisonAvgMinutes;
  const hasComparisonData = a.comparisonAvgMinutes > 0;

  // 레이더차트 5개 지표 중 실제 최저/최고 찾기 (고정 인덱스 아님)
  const radarValues = d.radarMetrics.values;
  const radarLabels = d.radarMetrics.labels;
  const minIdx = radarValues.indexOf(Math.min(...radarValues));
  const maxIdx = radarValues.indexOf(Math.max(...radarValues));
  const pct = hasComparisonData
    ? Math.round((diff / a.comparisonAvgMinutes) * 100)
    : 0;
  const growthClass = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '–';

  const isDaily = currentRange === 'daily';
  const maxBarValue = isDaily
    ? AXIS_MAX_MINUTES
    : niceAxisMax(
        Math.max(
          ...a.bars.map((b) => b.minutes),
          a.comparisonAvgMinutes,
          a.periodGoalMinutes,
        ),
      );
  const axisTickItems = isDaily
    ? DAILY_AXIS_TICKS
    : [
        maxBarValue,
        maxBarValue * 0.75,
        maxBarValue * 0.5,
        maxBarValue * 0.25,
        0,
      ].map((v) => ({ minutes: v, label: formatAxisMinutes(Math.round(v)) }));

  const earnedBadges = d.badges.filter(
    (b) => !b.pending && b.currentValue >= b.tiers[0],
  );
  // 이번 달에 새로 획득한 뱃지만 (사이드바 미니 목록용)
  const monthBadges = earnedBadges.filter((b) =>
    d.profile.monthBadgeKeys.includes(b.key),
  );
  const todayGoal = d.analysis.daily;

  return (
    <>
      <div style={topbar}>
        <img
          src={logo}
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
              src={logo}
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

      <div className="mypage2">
        {/* ================= 왼쪽 프로필 사이드바 ================= */}
        <aside className="profile-sidebar">
          <div className="avatar-lg">{d.profile.initial}</div>
          <div className="name">{d.profile.name}님</div>

          <div className="ps-stat-grid">
            <div className="ps-stat">
              <div className="ic">⏱️</div>
              <div className="v">{d.profile.totalHours}h</div>
              <div className="l">누적 학습</div>
            </div>
            <div className="ps-stat">
              <div className="ic">🏅</div>
              <div className="v">{d.profile.badgeCount}</div>
              <div className="l">뱃지</div>
            </div>
            <div className="ps-stat">
              <div className="ic">🔥</div>
              <div className="v">{d.profile.streakDays}일</div>
              <div className="l">연속 학습</div>
            </div>
            <div className="ps-stat">
              <div className="ic">✅</div>
              <div className="v">{d.profile.weeklyAchievementRate}%</div>
              <div className="l">이번 주 달성</div>
            </div>
          </div>

          <div className="ps-progress">
            <div className="row">
              <span>다음 뱃지까지</span>
              <span>{d.profile.nextBadge.label}</span>
            </div>
            <div className="track">
              <div
                className="fill"
                style={{ width: `${d.profile.nextBadge.progressPct}%` }}
              />
            </div>
          </div>

          <div className="ps-badges-label">
            이번 달에 {monthBadges.length}개의 뱃지를 획득했어요!
          </div>
          <div className="ps-badges-row">
            {monthBadges.slice(0, 3).map((b) => (
              <div className="b" key={b.key}>
                <img src={b.tierIcons[getAchievedTier(b) - 1]} alt={b.label} />
              </div>
            ))}
          </div>
        </aside>

        <div className="mypage2-main">
          {/* ================= 상단 3개 카드 ================= */}
          <div className="dash-top-row">
            <div className="top-card">
              <div className="head">
                <div
                  className="ic-box"
                  style={{ background: 'var(--accent-soft)' }}
                >
                  📝
                </div>
                <div className="title">오늘 할일</div>
              </div>
              <div className="today-list">
                {d.todayTodos.items.map((t) => (
                  <span key={t.id}>
                    {t.completed ? '✓' : '·'} [{t.subject}] {t.content} (
                    {t.progressRate}%)
                  </span>
                ))}
              </div>
            </div>

            <div className="top-card">
              <div className="head">
                <div
                  className="ic-box"
                  style={{ background: 'var(--lav-soft)' }}
                >
                  🎯
                </div>
                <div className="title">학습목표</div>
              </div>
              <div className="ps-progress" style={{ textAlign: 'left' }}>
                <div className="row">
                  <span>
                    {formatGoalMinutes(todayGoal.periodActualMinutes)} /{' '}
                    {formatGoalMinutes(todayGoal.periodGoalMinutes)}
                  </span>
                  <span>{todayGoal.periodRate}%</span>
                </div>
                <div className="track" style={{ marginBottom: 0 }}>
                  <div
                    className="fill"
                    style={{ width: `${Math.min(todayGoal.periodRate, 100)}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* ================= 학습분석 + 학습 리포트 ================= */}
          <div className="dash-analysis-row">
            <div className="analysis-card">
              <div className="ac-head">
                <h3>학습분석</h3>
                <div className="view-toggle">
                  <button
                    className={currentRange === 'daily' ? 'active' : ''}
                    onClick={() => setCurrentRange('daily')}
                  >
                    일간
                  </button>
                  <button
                    className={currentRange === 'weekly' ? 'active' : ''}
                    onClick={() => setCurrentRange('weekly')}
                  >
                    주간
                  </button>
                </div>
              </div>

              <div className="streak-banner">🔥 {a.streakText}</div>

              <div className="goal-stats">
                <div className="row">
                  <span>🚩 {a.goalLabel}</span>
                  <b>{formatGoalMinutes(a.periodGoalMinutes)}</b>
                </div>
                <div className="row">
                  <span>⏱️ {a.actualLabel}</span>
                  <b>{formatGoalMinutes(a.periodActualMinutes)}</b>
                </div>
                <div className="row">
                  <span>🎯 {a.rateLabel}</span>
                  <b>{a.periodRate}%</b>
                </div>
              </div>

              <hr className="sep sep-wide" />

              <div className="growth-row">
                {hasComparisonData ? (
                  <>
                    <span>
                      {a.comparisonLabel}({formatGoalMinutes(a.comparisonAvgMinutes)}) 대비
                    </span>
                    <span className={`growth-badge ${growthClass}`}>
                      {arrow} {Math.abs(pct)}%
                    </span>
                  </>
                ) : (
                  <span>아직 비교할 만큼의 학습 기록이 없어요</span>
                )}
              </div>

              <div className="mini-bars-wrap">
                <div className="mini-bars-axis">
                  {axisTickItems.map((t, i) => (
                    <span key={i}>{t.label}</span>
                  ))}
                </div>
                <div className="mini-bars">
                  {a.bars.map((b) => (
                    <div
                      className={`colb ${b.today ? 'today' : ''}`}
                      key={b.label}
                    >
                      <div className="bar-pair">
                        <div
                          className="actual"
                          style={{
                            height: `${Math.min(100, (b.minutes / maxBarValue) * 100)}%`,
                          }}
                        />
                        <div
                          className="avg"
                          style={{
                            height: `${Math.min(100, (a.comparisonAvgMinutes / maxBarValue) * 100)}%`,
                          }}
                        />
                      </div>
                      <span className="lbl">{b.label}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mini-bars-legend">
                <span>
                  <span
                    className="dot"
                    style={{ background: 'var(--lav-deep)' }}
                  />
                  나의 학습시간
                </span>
                <span>
                  <span className="dot" style={{ background: 'var(--line)' }} />
                  {a.comparisonLabel}
                </span>
              </div>

              <hr className="sep" />

              <div className="callout">
                <span className="q">"</span>
                <span>
                  {!hasComparisonData ? (
                    <>첫 학습 기록이 쌓이고 있어요, 계속 이어가 보세요!"</>
                  ) : diff >= 0 ? (
                    <>
                      {a.comparisonLabel}보다 {a.periodLabel}{' '}
                      <b>{formatGoalMinutes(Math.abs(diff))}</b> 더 학습했어요!
                    </>
                  ) : (
                    <>
                      {a.comparisonLabel}보다 {a.periodLabel}{' '}
                      <b>{formatGoalMinutes(Math.abs(diff))}</b> 적게 학습했어요.
                    </>
                  )}
                </span>
              </div>
            </div>

            <div className="analysis-card">
              <div className="ac-head">
                <h3>나의 학습 리포트</h3>
                <div className="view-toggle">
                  <button className="active">이번 주</button>
                </div>
              </div>
              <div className="radar-wrap">
                <RadarCanvas metrics={d.radarMetrics} />
              </div>
              <div className="callout">
                <span className="q">"</span>
                <span>
                  가장 낮은 지표는{' '}
                  <b>
                    {radarLabels[minIdx]}({radarValues[minIdx]}%)
                  </b>
                  , 가장 높은 지표는{' '}
                  <b>
                    {radarLabels[maxIdx]}({radarValues[maxIdx]}%)
                  </b>
                  이에요!"
                </span>
              </div>
            </div>
          </div>

          {/* ================= 획득한 뱃지 ================= */}
          <div className="badge-section">
            <h3>획득한 뱃지</h3>
            <div className="badge-card-grid">
              {earnedBadges.length === 0 ? (
                <p className="badge-empty">
                  아직 획득한 뱃지가 없어요. 학습을 시작해보세요!
                </p>
              ) : (
                earnedBadges.map((b) => (
                  <div className="badge-earned" key={b.key}>
                    <div className="ic">
                      <img
                        src={b.tierIcons[getAchievedTier(b) - 1]}
                        alt={b.label}
                      />
                    </div>
                    <div className="lbl">{b.label}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
