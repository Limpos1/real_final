// study-stats-data.js
// 학습통계 화면(StudyStatsScreen.jsx)에 필요한 데이터를 전부 모아서
// 돌려주는 함수. StudyStatsScreen.jsx는 이 함수 하나만 부르면 됨.
// (예전 이름 mypage-data.js/getMyPageData였으나, 실제로 쓰는 화면은
//  마이페이지가 아니라 학습통계라서 이름을 맞춰 바꿈.)

import { db } from "../firebase";
import { collection, query, where, getDocs, doc, getDoc, Timestamp } from "firebase/firestore";
import { getRadarMetrics } from "./radar-metrics";
import {
  BADGE_DEFS,
  getClosestNextBadge,
  calculateStreakDays,
  calculateQuizCorrectCount,
  calculatePlanCompletionCount,
  calculatePerfectDayCount,
  calculateTotalStudyHours,
} from "./badgeChecker";

// 뱃지 아이콘 경로는 이미지 파일 기준이라 계산으로 안 나옴 - 고정값 유지
const BADGE_TIER_ICONS = {
  streak: ["/assets/badges/streak-1.png","/assets/badges/streak-2.png","/assets/badges/streak-3.png","/assets/badges/streak-4.png","/assets/badges/streak-5.png"],
  quizMaster: ["/assets/badges/quizMaster-1.png","/assets/badges/quizMaster-2.png","/assets/badges/quizMaster-3.png","/assets/badges/quizMaster-4.png","/assets/badges/quizMaster-5.png"],
  planCompletion: ["/assets/badges/planCompletion-1.png","/assets/badges/planCompletion-2.png","/assets/badges/planCompletion-3.png","/assets/badges/planCompletion-4.png","/assets/badges/planCompletion-5.png"],
  perfectDay: ["/assets/badges/perfectDay-1.png","/assets/badges/perfectDay-2.png","/assets/badges/perfectDay-3.png","/assets/badges/perfectDay-4.png","/assets/badges/perfectDay-5.png"],
  totalStudyTime: ["/assets/badges/totalStudyTime-1.png","/assets/badges/totalStudyTime-2.png","/assets/badges/totalStudyTime-3.png","/assets/badges/totalStudyTime-4.png","/assets/badges/totalStudyTime-5.png"],
};

const BADGE_VALUE_CALCULATORS = {
  streak: calculateStreakDays,
  quizMaster: calculateQuizCorrectCount,
  planCompletion: calculatePlanCompletionCount,
  perfectDay: calculatePerfectDayCount,
  totalStudyTime: calculateTotalStudyHours,
};

// toISOString()은 UTC 기준이라 한국(UTC+9)에서는 날짜가 하루 어긋난다.
// 그래서 브라우저 로컬 날짜(YYYY-MM-DD)로 만든다. (sv-SE 로케일 = ISO 형식)
function toDateString(date) {
  return date.toLocaleDateString("sv-SE");
}
function todayString() {
  return toDateString(new Date());
}
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
// "이번 주"는 월요일 시작(월~일)으로 통일한다.
function mondayOf(date) {
  const d = startOfDay(date);
  const day = d.getDay(); // 일=0, 월=1, ..., 토=6
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  return d;
}

// 특정 날짜 범위의 study_sessions 합계(분)
async function getSessionMinutes(memberId, startDate, endDate) {
  const q = query(
    collection(db, "study_sessions"),
    where("memberId", "==", memberId),
    where("startedAt", ">=", Timestamp.fromDate(startOfDay(startDate))),
    where("startedAt", "<", Timestamp.fromDate(startOfDay(endDate)))
  );
  const snap = await getDocs(q);
  return snap.docs.reduce((sum, d) => sum + (d.data().durationSeconds || 0), 0) / 60;
}

// 특정 날짜 범위의 study_plan_item durationMinutes 합계(목표 분)
async function getGoalMinutes(memberId, dateStrings) {
  // 날짜마다 하나씩 기다리지 않고 한꺼번에 조회한다.
  const totals = await Promise.all(
    dateStrings.map(async (dateStr) => {
      const q = query(
        collection(db, "study_plan_items"),
        where("memberId", "==", memberId),
        where("planDate", "==", dateStr)
      );
      const snap = await getDocs(q);
      return snap.docs.reduce((sum, d) => sum + (d.data().durationMinutes || 0), 0);
    })
  );
  return totals.reduce((sum, t) => sum + t, 0);
}

function dateRange(start, days) {
  const arr = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    arr.push(toDateString(d));
  }
  return arr;
}

// ---------------------------------------------------------------
// 일간 분석 (월~일 요일별)
// ---------------------------------------------------------------
async function getDailyAnalysis(memberId) {
  const now = new Date();
  const weekStart = mondayOf(now); // 이번 주 월요일

  const dates = dateRange(weekStart, 7);
  const labels = ["월", "화", "수", "목", "금", "토", "일"];

  // "나의 평균" = 최근 30일 하루 평균 학습시간
  const past30Start = new Date(now);
  past30Start.setDate(now.getDate() - 30);

  // 서로 관련 없는 조회는 순서대로 기다리지 않고 한꺼번에 보낸다.
  const [barMinutes, todayGoal, past30Minutes, streakDays] = await Promise.all([
    Promise.all(
      dates.map((_, i) => {
        const dayStart = new Date(weekStart);
        dayStart.setDate(weekStart.getDate() + i);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayStart.getDate() + 1);
        return getSessionMinutes(memberId, dayStart, dayEnd);
      })
    ),
    getGoalMinutes(memberId, [todayString()]),
    getSessionMinutes(memberId, past30Start, now),
    calculateStreakDays(memberId),
  ]);

  const bars = barMinutes.map((minutes, i) => {
    const isToday = dates[i] === todayString();
    return { label: isToday ? `${labels[i]}(오늘)` : labels[i], minutes: Math.round(minutes), today: isToday };
  });

  const todayActual = bars.find((b) => b.today)?.minutes || 0;
  const todayRate = todayGoal > 0 ? Math.min(100, Math.round((todayActual / todayGoal) * 100)) : 0;
  const myAverage = Math.round(past30Minutes / 30);

  return {
    periodLabel: "오늘", goalLabel: "오늘 학습목표", actualLabel: "오늘 학습한 시간", rateLabel: "오늘 목표 달성률",
    periodGoalMinutes: todayGoal, periodActualMinutes: todayActual, periodRate: todayRate,
    streakText: `${streakDays}일 연속 학습중이에요!`,
    comparisonLabel: "나의 평균", comparisonAvgMinutes: myAverage,
    bars,
  };
}

// ---------------------------------------------------------------
// 주간 분석 (이번 달 1주~4주)
// ---------------------------------------------------------------
async function getWeeklyAnalysis(memberId) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1); // 다음 달 1일 (배타적 끝)

  // 이번 달을 실제 월~일 7일짜리 주 단위로 나눈다. 막대 개수를 고정하지 않고,
  // 그 달이 실제로 걸치는 주 수만큼(보통 4~6개) 만든다 - 그래서 "1주"라고 적힌 막대가
  // 실제로는 13일치인 것 같은 왜곡이 없다. 각 막대는 항상 정확히 7일이며, 달의 양 끝
  // 며칠은 이웃 달의 날짜를 포함할 수 있다(달력에서 흔히 보이는 방식과 동일).
  const weekRanges = [];
  for (let cursor = mondayOf(monthStart); cursor < monthEnd; ) {
    const start = new Date(cursor);
    const end = new Date(cursor);
    end.setDate(end.getDate() + 7);
    weekRanges.push({ start, end });
    cursor = end;
  }

  // "지난달 주간 평균"용 기간
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1);

  // 서로 관련 없는 조회는 순서대로 기다리지 않고 한꺼번에 보낸다.
  const [barMinutes, lastMonthMinutes] = await Promise.all([
    Promise.all(weekRanges.map(({ start, end }) => getSessionMinutes(memberId, start, end))),
    getSessionMinutes(memberId, lastMonthStart, lastMonthEnd),
  ]);

  const bars = barMinutes.map((minutes, w) => ({
    label: `${w + 1}주`,
    minutes: Math.round(minutes),
    today: now >= weekRanges[w].start && now < weekRanges[w].end,
  }));

  // "오늘"이 있는 막대는 항상 실제 이번 주(월~일)와 정확히 같은 7일이라,
  // 별도로 다시 조회하지 않고 이 막대 값을 그대로 쓴다.
  const thisWeekIndex = bars.findIndex((b) => b.today);
  const thisWeekBar = bars[thisWeekIndex];
  const thisWeekRange = weekRanges[thisWeekIndex];
  const weekGoal = await getGoalMinutes(memberId, dateRange(thisWeekRange.start, 7));
  const weekRate = weekGoal > 0 ? Math.min(100, Math.round((thisWeekBar.minutes / weekGoal) * 100)) : 0;
  const lastMonthWeeklyAvg = Math.round(lastMonthMinutes / 4);

  return {
    periodLabel: "이번 주", goalLabel: "주간 학습목표", actualLabel: "이번 주 학습한 시간", rateLabel: "이번 주 목표 달성률",
    periodGoalMinutes: weekGoal, periodActualMinutes: thisWeekBar.minutes, periodRate: weekRate,
    streakText: `이번 달 학습 현황`,
    comparisonLabel: "지난달 주간 평균", comparisonAvgMinutes: lastMonthWeeklyAvg,
    bars,
  };
}

// ---------------------------------------------------------------
// 전체 학습통계 데이터 조립
// ---------------------------------------------------------------
export async function getStudyStatsData(memberId) {
  // 서로 관련 없는 조회를 전부 한꺼번에 보낸다 (하나씩 기다리면 로딩이 길어진다).
  const [
    userSnap, totalHours, streakDays, radarMetrics, nextBadge, dailyAnalysis, weeklyAnalysis,
    badgesSnap, badgeValues, todayItemsSnap,
  ] = await Promise.all([
    // 이름은 항상 users/{memberId} 문서에서 최신 값을 직접 읽는다
    // (마이페이지에서 이름 수정하면 여기도 바로 반영되게).
    getDoc(doc(db, "users", memberId)),
    calculateTotalStudyHours(memberId),
    calculateStreakDays(memberId),
    getRadarMetrics(memberId),
    getClosestNextBadge(memberId),
    getDailyAnalysis(memberId),
    getWeeklyAnalysis(memberId),
    // 뱃지 개수(멤버 문서 기준)
    getDocs(collection(db, "members", memberId, "badges")),
    // 뱃지별 currentValue 계산 (5개 병렬)
    Promise.all(BADGE_DEFS.map((def) => BADGE_VALUE_CALCULATORS[def.key](memberId))),
    // 오늘 할일
    getDocs(query(
      collection(db, "study_plan_items"),
      where("memberId", "==", memberId),
      where("planDate", "==", todayString())
    )),
  ]);

  const memberName = userSnap.exists() ? (userSnap.data().name || "회원") : "회원";
  const badgeCount = badgesSnap.size;

  // 이번 달에 획득(승급 포함)한 뱃지 키 목록 - earnedAt이 이번 달 1일 이후인 것
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthBadgeKeys = badgesSnap.docs
    .filter((bd) => {
      const earned = bd.data().earnedAt?.toDate?.();
      return earned && earned >= monthStart;
    })
    .map((bd) => bd.id);

  const badges = BADGE_DEFS.map((def, i) => ({
    key: def.key,
    label: def.label,
    unit: def.unit,
    tiers: def.tiers,
    tierIcons: BADGE_TIER_ICONS[def.key],
    currentValue: badgeValues[i],
  }));

  const todayItems = todayItemsSnap.docs.map((d) => ({
    id: d.id,
    subject: d.data().subject,
    content: d.data().content,
    progressRate: d.data().progressRate,
    completed: d.data().progressRate === 100,
  }));

  return {
    profile: {
      name: memberName,
      initial: memberName.slice(0, 1),
      totalHours: Math.round(totalHours * 10) / 10,
      badgeCount,
      monthBadgeKeys,
      streakDays,
      weeklyAchievementRate: weeklyAnalysis.periodRate,
      nextBadge: nextBadge || { label: "모든 뱃지 최고 단계 달성!", progressPct: 100 },
    },
    todayTodos: { items: todayItems },
    analysis: { daily: dailyAnalysis, weekly: weeklyAnalysis },
    radarMetrics,
    badges,
  };
}
