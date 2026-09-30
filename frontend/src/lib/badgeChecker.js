// badgeChecker.js
// 회원의 실제 데이터를 뱃지 기준(tiers)과 비교해서, 새로 달성한 단계가
// 있으면 members/{memberId}/badges/{badgeKey} 에 기록한다.
// 언제 부르나: 지금은 "마이페이지 열 때마다"(MyPageScreen.jsx의 useEffect).

import { db } from "../firebase";
import {
  collection, collectionGroup, query, where, getDocs,
  doc, setDoc, getDoc, Timestamp,
} from "firebase/firestore";
import { studyStatsRef } from "./study-session";

// 뱃지 정의 (mock-data.js의 badges 배열과 tiers/label 동일하게 유지)
export const BADGE_DEFS = [
  { key: "streak", label: "연속 학습일", unit: "일", tiers: [7, 30, 90, 180, 365] },
  { key: "quizMaster", label: "퀴즈 정답왕", unit: "개", tiers: [10, 50, 100, 300, 500] },
  { key: "planCompletion", label: "계획 완주", unit: "개", tiers: [1, 3, 5, 10, 15] },
  { key: "perfectDay", label: "완벽한 날", unit: "번", tiers: [5, 10, 50, 100, 500] },
  { key: "totalStudyTime", label: "누적 학습시간", unit: "시간", tiers: [5, 10, 50, 100, 500] },
];

// toISOString()은 UTC 기준이라 한국(UTC+9)에서는 날짜가 하루 어긋난다 -> 로컬 날짜 사용
function todayString() {
  return new Date().toLocaleDateString("sv-SE"); // "YYYY-MM-DD"
}

// ---------------------------------------------------------------
// 뱃지별 "현재 값" 계산
// ---------------------------------------------------------------
async function calculateStreakDays(memberId) {
  const q = query(
    collection(db, "study_plan_items"),
    where("memberId", "==", memberId),
    where("progressRate", ">", 0)
  );
  const snap = await getDocs(q);
  const dates = [...new Set(snap.docs.map((d) => d.data().planDate))].sort();
  if (dates.length === 0) return 0;

  let streak = 1;
  for (let i = dates.length - 1; i > 0; i--) {
    const diffDays = (new Date(dates[i]) - new Date(dates[i - 1])) / 86400000;
    if (diffDays === 1) streak++;
    else break;
  }
  const diffFromToday = (new Date(todayString()) - new Date(dates[dates.length - 1])) / 86400000;
  return diffFromToday > 1 ? 0 : streak;
}

async function calculateQuizCorrectCount(memberId) {
  // ⚠️ quizzes 컬렉션은 memberId가 아니라 uid 필드를 씀
  const quizzesSnap = await getDocs(query(collection(db, "quizzes"), where("uid", "==", memberId)));
  // 퀴즈마다 answers를 하나씩 기다리지 않고 한꺼번에 조회한다.
  const answerSnaps = await Promise.all(
    quizzesSnap.docs.map((quizDoc) => getDocs(collection(db, "quizzes", quizDoc.id, "answers")))
  );
  let correct = 0;
  answerSnaps.forEach((snap) => snap.forEach((a) => { if (a.data().correct) correct++; }));
  return correct;
}

async function calculatePlanCompletionCount(memberId) {
  const snap = await getDocs(query(
    collection(db, "study_plan_items"),
    where("memberId", "==", memberId),
    where("progressRate", "==", 100)
  ));
  return snap.size;
}

async function calculatePerfectDayCount(memberId) {
  const snap = await getDocs(query(collection(db, "study_plan_items"), where("memberId", "==", memberId)));
  const byDate = {};
  snap.docs.forEach((d) => {
    const data = d.data();
    (byDate[data.planDate] ??= []).push(data.progressRate);
  });
  return Object.values(byDate).filter((rates) => rates.every((r) => r === 100)).length;
}

// 누적 학습시간(시간 단위).
// 기록이 쌓일수록 느려지지 않도록, 저장할 때마다 늘려 둔 누적값(members/{id}/stats/study)을
// 읽는다 (저장하는 쪽: study-session.js). 화면 하나를 여는 동안 여러 곳에서 동시에 부르므로,
// 이미 조회 중이면 그 결과를 같이 쓴다.
const pendingTotalSeconds = new Map();

async function calculateTotalStudyHours(memberId) {
  if (!pendingTotalSeconds.has(memberId)) {
    const p = loadTotalStudySeconds(memberId).finally(() => pendingTotalSeconds.delete(memberId));
    pendingTotalSeconds.set(memberId, p);
  }
  return (await pendingTotalSeconds.get(memberId)) / 3600;
}

async function loadTotalStudySeconds(memberId) {
  const ref = studyStatsRef(memberId);

  let snap = null;
  try {
    snap = await getDoc(ref);
  } catch {
    // 누적값을 못 읽어도 통계가 멈추지 않도록 아래에서 전체를 합산한다.
  }
  if (snap && snap.exists() && snap.data().backfilled === true) {
    return snap.data().totalSeconds || 0;
  }

  // 아직 누적값이 없는 경우(이 기능 이전에 쌓인 기록 포함): 전체를 한 번만 합산해서 저장해 둔다.
  // 다음부터는 위처럼 저장된 값을 읽는다.
  const sessions = await getDocs(query(collection(db, "study_sessions"), where("memberId", "==", memberId)));
  const total = sessions.docs.reduce((sum, d) => sum + (d.data().durationSeconds || 0), 0);
  try {
    await setDoc(ref, { totalSeconds: total, backfilled: true, updatedAt: Timestamp.now() });
  } catch {
    // 저장에 실패해도 이번 값은 정확하므로 그대로 돌려준다 (다음에 다시 시도).
  }
  return total;
}

const VALUE_CALCULATORS = {
  streak: calculateStreakDays,
  quizMaster: calculateQuizCorrectCount,
  planCompletion: calculatePlanCompletionCount,
  perfectDay: calculatePerfectDayCount,
  totalStudyTime: calculateTotalStudyHours,
};

function getAchievedTier(currentValue, tiers) {
  const fromEnd = [...tiers].reverse().findIndex((t) => currentValue >= t);
  return fromEnd === -1 ? 0 : tiers.length - fromEnd;
}

// ---------------------------------------------------------------
// 전체 뱃지 판정 + 새로 달성한 것만 기록
// 반환값: 이번 호출에서 "새로 승급된" 뱃지 목록 (알림 등에 활용 가능)
// ---------------------------------------------------------------
export async function checkAndAwardBadges(memberId) {
  // 5개 뱃지를 하나씩 기다리지 않고 동시에 판정한다 (뱃지마다 다른 문서라 서로 영향 없음).
  const results = await Promise.all(
    BADGE_DEFS.map(async (def) => {
      const currentValue = await VALUE_CALCULATORS[def.key](memberId);
      const tierNum = getAchievedTier(currentValue, def.tiers);
      if (tierNum === 0) return null;

      const badgeRef = doc(db, "members", memberId, "badges", def.key);
      const existing = await getDoc(badgeRef);
      const existingTier = existing.exists() ? existing.data().tier : 0;

      if (tierNum > existingTier) {
        await setDoc(badgeRef, {
          badgeKey: def.key,
          tier: tierNum,
          currentValue,
          earnedAt: Timestamp.now(),
        });
        return { ...def, tier: tierNum };
      }
      return null;
    })
  );

  return results.filter(Boolean);
}

// ---------------------------------------------------------------
// "이번 달 획득 개수" — earnedAt이 이번 달인 것만 카운트
// ---------------------------------------------------------------
export async function getBadgesEarnedThisMonth(memberId) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const snap = await getDocs(collection(db, "members", memberId, "badges"));
  return snap.docs.filter((d) => d.data().earnedAt.toDate() >= monthStart).length;
}

// 남은 양 표시. 누적 학습시간은 소수(0.1555시간)로 나오므로 "n시간 m분"으로 바꾼다.
// (올림해서 거의 다 왔을 때 "0분 남음"으로 보이지 않게 함. 1e-6은 부동소수점 오차 방지)
function formatRemaining(def, remaining) {
  if (def.key !== "totalStudyTime") return `${remaining}${def.unit}`;
  const totalMinutes = Math.ceil(remaining * 60 - 1e-6);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

// ---------------------------------------------------------------
// "다음 뱃지까지" — 진행률(%)이 가장 높은(=가장 가까운) 것 하나 선택
// ---------------------------------------------------------------
export async function getClosestNextBadge(memberId) {
  let closest = null;
  let closestProgress = -1;

  // 5개 뱃지의 현재 값을 한꺼번에 계산해 둔다.
  const values = await Promise.all(
    BADGE_DEFS.map((def) => VALUE_CALCULATORS[def.key](memberId))
  );

  for (let i = 0; i < BADGE_DEFS.length; i++) {
    const def = BADGE_DEFS[i];
    const currentValue = values[i];
    const tierNum = getAchievedTier(currentValue, def.tiers);
    if (tierNum === 5) continue; // 이미 최고 단계

    const nextThreshold = def.tiers[tierNum];
    const prevThreshold = tierNum > 0 ? def.tiers[tierNum - 1] : 0;
    const progress = (currentValue - prevThreshold) / (nextThreshold - prevThreshold);

    if (progress > closestProgress) {
      closestProgress = progress;
      closest = {
        label: `${nextThreshold}${def.unit} ${def.label}까지 ${formatRemaining(def, nextThreshold - currentValue)} 남음`,
        progressPct: Math.round(progress * 100),
      };
    }
  }
  return closest;
}

// ---------------------------------------------------------------
// 개별 계산 함수도 밖에서 재사용할 수 있게 추가로 내보냄
// (프로필 사이드바의 "누적학습", "연속학습" 등에서 재사용)
// ---------------------------------------------------------------
export {
  calculateStreakDays,
  calculateQuizCorrectCount,
  calculatePlanCompletionCount,
  calculatePerfectDayCount,
  calculateTotalStudyHours,
};
