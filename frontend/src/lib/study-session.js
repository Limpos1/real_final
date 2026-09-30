// study-session.js
// 스톱워치로 잰 학습 기록을 저장하는 곳.
//
// 기록 한 건(study_sessions)을 저장할 때, "가입 이후 누적 학습시간"도 같은 순간에
// 함께 늘려 둔다 (members/{memberId}/stats/study 의 totalSeconds).
// 이렇게 해 두면 누적 학습시간을 구할 때 기록 전체를 다시 읽어서 더할 필요가 없다
// (badgeChecker.js의 calculateTotalStudyHours가 이 값을 읽는다).
//
// 두 쓰기는 배치로 묶어서 "둘 다 저장되거나 둘 다 안 되거나" 하게 한다.

import { db } from "../firebase";
import {
  collection, doc, writeBatch, increment, serverTimestamp, Timestamp,
} from "firebase/firestore";

// 누적 통계 문서 위치. 읽는 쪽(badgeChecker.js)도 이 함수를 쓴다.
export function studyStatsRef(memberId) {
  return doc(db, "members", memberId, "stats", "study");
}

export async function saveStudySession(memberId, startedAt, durationSeconds) {
  const batch = writeBatch(db);

  // 학습 기록 1건 (막대그래프 등 기간별 통계는 이 기록을 그대로 읽는다)
  batch.set(doc(collection(db, "study_sessions")), {
    memberId,
    startedAt: Timestamp.fromDate(startedAt),
    durationSeconds,
  });

  // 누적 학습시간 증가 (문서가 없으면 새로 만들어진다)
  batch.set(
    studyStatsRef(memberId),
    { totalSeconds: increment(durationSeconds), updatedAt: serverTimestamp() },
    { merge: true },
  );

  await batch.commit();
}

// 메인이 아닌 화면(마이페이지·학습통계·챗봇)에서 로그아웃할 때 쓴다.
// 메인 화면이 localStorage에 백업해 둔 스톱워치 시간을 학습 기록으로 저장하고 백업을 지운다.
// 백업을 남겨 두면 다시 로그인했을 때 "로그아웃해 있던 시간"까지 경과 시간으로 더해지므로,
// 저장에 실패해도 백업은 반드시 지운다.
export async function saveStopwatchAndClear(userId) {
  const key = `planit_stopwatch_${userId}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const saved = JSON.parse(raw);
    const elapsed = saved.running
      ? Math.max(0, Math.floor((Date.now() - saved.savedAt) / 1000))
      : 0;
    const seconds = (saved.seconds || 0) + elapsed;
    if (seconds > 0) {
      const startedAt = saved.startedAt
        ? new Date(saved.startedAt)
        : new Date(Date.now() - seconds * 1000);
      await saveStudySession(userId, startedAt, seconds);
    }
  } catch {
    // 저장 실패해도 로그아웃은 계속 진행한다.
  } finally {
    try {
      localStorage.removeItem(key);
    } catch {
      // 무시
    }
  }
}
