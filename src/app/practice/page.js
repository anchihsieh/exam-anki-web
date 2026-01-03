"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { db, ensureAnonAuth } from "@/lib/firebase";
import {
  addDoc,
  collection,
  getDocs,
  limit,
  query,
  where,
  serverTimestamp,
  doc,
  setDoc,
  getDoc,
} from "firebase/firestore";

const DEBUG_MODE = false;

/** ---------- UI styles ---------- */
const pageStyle = {
  padding: 18,
  fontFamily: "system-ui",
  background: "#f6f7fb",
  minHeight: "100vh",
  color: "#111",
};

const cardStyle = {
  background: "white",
  border: "1px solid #e9e9ef",
  borderRadius: 14,
  padding: 16,
};

const chipStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  borderRadius: 999,
  border: "1px solid #e9e9ef",
  background: "#fff",
  fontSize: 13,
  color: "#111",
};

const btnStyle = {
  padding: "14px 16px",
  fontSize: 18,
  borderRadius: 14,
  border: "1px solid #d9d9e3",
  background: "white",
  color: "#111",
  cursor: "pointer",
  width: "100%",
};

const btnPrimary = {
  ...btnStyle,
  border: "1px solid #111",
  background: "#111",
  color: "white",
};

const bottomBar = {
  position: "sticky",
  bottom: 0,
  background: "#f6f7fb",
  paddingTop: 12,
  paddingBottom: 12,
};

function nowMs() {
  return Date.now();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function msToSec(ms) {
  return Math.round((ms || 0) / 1000);
}

function safeUpper(v) {
  return String(v ?? "").trim().toUpperCase();
}

function safeStr(v) {
  return String(v ?? "").trim();
}

/** ---------- Weighted sampling helpers ---------- */
function weightedSampleNoReplace(items, k, getWeight) {
  const pool = items.map((it) => ({ it, w: Math.max(0, Number(getWeight(it)) || 0) }));
  const picked = [];
  for (let t = 0; t < k && pool.length > 0; t++) {
    const total = pool.reduce((acc, x) => acc + x.w, 0);
    if (total <= 0) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool[idx].it);
      pool.splice(idx, 1);
      continue;
    }
    let r = Math.random() * total;
    let chosenIndex = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w;
      if (r <= 0) {
        chosenIndex = i;
        break;
      }
    }
    picked.push(pool[chosenIndex].it);
    pool.splice(chosenIndex, 1);
  }
  return picked;
}

function buildStatsMap(statsDocs) {
  const m = new Map();
  for (const s of statsDocs) {
    if (!s?.q_id) continue;
    m.set(String(s.q_id), s);
  }
  return m;
}

function calcWeight(q, stat) {
  const attempts = Number(stat?.attempts || 0);
  const wrong = Number(stat?.wrong || 0);
  const wrongRate = attempts > 0 ? wrong / attempts : 0;

  const familiarity = String(stat?.familiarity || "unknown");
  const needsPractice = familiarity === "needs_practice";
  const isMastered = familiarity === "mastered";

  const teacherPriority = Number(q?.teacher_priority || 0);
  const forceRepeat = !!q?.force_repeat;

  let w =
    1 +
    4 * wrongRate +
    (needsPractice ? 3 : 0) +
    2 * teacherPriority +
    (forceRepeat ? 2 : 0) +
    Math.random() * 0.8;

  // ✅ mastered：下回「大幅降低」但不歸零（仍可能抽到）
  if (isMastered) w *= 0.25;

  return w;
}


/** ---------- Main ---------- */
export default function PracticePage() {
  const router = useRouter();

  // ✅ avoid hydration mismatch: read localStorage in useEffect only
  const [booted, setBooted] = useState(false);
  const [userId, setUserId] = useState(null);
  const [userName, setUserName] = useState(null);
  const [subject, setSubject] = useState(null);

  const [loading, setLoading] = useState(true);

  const [questions, setQuestions] = useState([]);
  const [idx, setIdx] = useState(0);
  const currentQ = questions[idx];

  const [roundDebug, setRoundDebug] = useState([]);

  // ✅ summary encouragement from Firestore
  const [encouragementText, setEncouragementText] = useState("");
  const [encourageCount, setEncourageCount] = useState(0);
  const [encourageError, setEncourageError] = useState("");


  // phase: "answer" | "feedback" | "summary"
  const [phase, setPhase] = useState("answer");

  // timing
  const questionShownAtRef = useRef(null); // when question page shows
  const firstActionAtRef = useRef(null); // first click (TF pick / CARD reveal)

  const [sessionId, setSessionId] = useState(null);

  // local cache for summary
  const [records, setRecords] = useState([]);

  // feedback payload waiting for familiarity choice
  const [pendingAnswer, setPendingAnswer] = useState(null);

  // CARD UI state
  const [cardRevealed, setCardRevealed] = useState(false);

  useEffect(() => {
    const uid = localStorage.getItem("user_id");
    const uname = localStorage.getItem("user_name");
    const sub = localStorage.getItem("subject");
    setUserId(uid);
    setUserName(uname);
    setSubject(sub);
    setBooted(true);
  }, []);

  const totalSec = useMemo(() => {
    const ms = records.reduce((acc, r) => acc + (r.read_ms || 0) + (r.answer_ms || 0), 0);
    return msToSec(ms);
  }, [records]);

  const correctCount = useMemo(() => records.filter((r) => r.is_correct).length, [records]);

  const topicStats = useMemo(() => {
    const map = new Map();
    for (const r of records) {
      const topic = r.core_topic || "（未分類）";
      if (!map.has(topic)) {
        map.set(topic, { core_topic: topic, total_ms: 0, read_ms: 0, answer_ms: 0, count: 0 });
      }
      const t = map.get(topic);
      t.total_ms += (r.read_ms || 0) + (r.answer_ms || 0);
      t.read_ms += r.read_ms || 0;
      t.answer_ms += r.answer_ms || 0;
      t.count += 1;
    }
    return [...map.values()].sort((a, b) => b.total_ms - a.total_ms);
  }, [records]);

  function resetPerQuestionUI() {
    questionShownAtRef.current = nowMs();
    firstActionAtRef.current = null;
    setPendingAnswer(null);
    setCardRevealed(false);
    setPhase("answer");
  }

  async function loadRandomEncouragement() {
  const fallback = "完成一輪很棒！保持節奏，下一輪會更穩。";

  try {
    setEncourageError("");
    setEncourageCount(0);

    const eRef = collection(db, "encouragements");
    const eQy = query(eRef, where("active", "==", true), limit(50));
    const eSnap = await getDocs(eQy);

    const list = eSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    setEncourageCount(list.length);

    const texts = list
      .map((x) => (typeof x.text === "string" ? x.text.trim() : ""))
      .filter(Boolean);

    if (!texts.length) {
      setEncourageError(
        `Found ${list.length} docs but no valid text OR active isn't boolean true. Check: active must be boolean true`
      );
      setEncouragementText(fallback);
      return;
    }

    setEncouragementText(texts[Math.floor(Math.random() * texts.length)]);
  } catch (err) {
    console.log("encouragement load failed:", err);
    setEncourageError(String(err?.message || err));
    setEncouragementText(fallback);
  }
}


  // Load questions + create session
  useEffect(() => {
    (async () => {
      if (!booted) return;
      if (!userId || !subject) {
        router.push("/");
        return;
      }

      setLoading(true);
      await ensureAnonAuth();
      if (!db) return; // ✅ wait for client Firebase ready

      // ✅ 每輪先抓一則鼓勵詞（Summary 用）
      await loadRandomEncouragement();

      // 1) 讀題庫（TF + CARD）
      const qRef = collection(db, "questions");
      const qy = query(qRef, where("active", "==", true), where("subject", "==", subject), limit(800));
      const snap = await getDocs(qy);

      const allQ = snap.docs.map((d) => d.data()).filter((x) => x && x.q_id);

      const candidates = allQ.filter((q) => {
        const t = String(q.type || "").toUpperCase();
        return t === "TF" || t === "CARD" || t === "FLASHCARD";
      });

      // 2) 讀該使用者 stats（同科）
      const stRef = collection(db, "user_question_stats");
      const stQy = query(stRef, where("user_id", "==", userId), where("subject", "==", subject), limit(2000));
      const stSnap = await getDocs(stQy);
      const statsDocs = stSnap.docs.map((d) => d.data());
      const statsMap = buildStatsMap(statsDocs);

      // 3) 保守插入：force_repeat 最多 1 題
      const forceList = candidates.filter((q) => !!q.force_repeat);
      const forced = forceList.length ? [forceList[Math.floor(Math.random() * forceList.length)]] : [];

      // 4) 其餘用權重抽滿 10 題（不重複）
      const forcedIds = new Set(forced.map((q) => q.q_id));
      const remainingPool = candidates.filter((q) => {
        if (forcedIds.has(q.q_id)) return false;
        const s = statsMap.get(String(q.q_id));
        return String(s?.familiarity || "unknown") !== "mastered";
      });

      const need = Math.max(0, 10 - forced.length);
      const weightedPicked = weightedSampleNoReplace(remainingPool, need, (q) =>
        calcWeight(q, statsMap.get(String(q.q_id)))
      );

      // 5) 組合本輪
      const round = shuffle([...forced, ...weightedPicked]).slice(0, 10);

      // ✅ Debug：存每題摘要
      const debugRows = round.map((q) => {
        const s = statsMap.get(String(q.q_id));
        const attempts = Number(s?.attempts || 0);
        const wrong = Number(s?.wrong || 0);
        const wrongRate = attempts > 0 ? wrong / attempts : 0;
        return {
          q_id: q.q_id,
          type: String(q.type || "").toUpperCase(),
          core_topic: q.core_topic || "",
          weight: calcWeight(q, s),
          attempts,
          wrong,
          wrongRate: Number(wrongRate.toFixed(2)),
          familiarity: String(s?.familiarity || "unknown"),
          teacher_priority: Number(q?.teacher_priority || 0),
          force_repeat: !!q?.force_repeat,
        };
      });
      setRoundDebug(debugRows);

      // 套用本輪
      setQuestions(round);
      setIdx(0);
      setRecords([]);
      setPendingAnswer(null);
      setPhase("answer");

      // create session
      const sRef2 = await addDoc(collection(db, "sessions"), {
        user_id: userId,
        user_name: userName || null,
        subject,
        started_at: serverTimestamp(),
        total_questions: round.length,
        status: "in_progress",
      });
      setSessionId(sRef2.id);

      resetPerQuestionUI();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, userId, subject]);

  /** ---------- Answer submit handlers ---------- */

  // TF: click TRUE/FALSE -> immediately go feedback
  function onTFPick(val) {
    if (!currentQ || phase !== "answer") return;

    if (!firstActionAtRef.current) firstActionAtRef.current = nowMs();

    const read_ms = Math.max(0, (firstActionAtRef.current || nowMs()) - (questionShownAtRef.current || nowMs()));
    const answer_ms = 0;

    const correctAnswer = safeUpper(currentQ.answer_key) === "TRUE";
    const isCorrect = val === correctAnswer;

    const rec = {
      q_id: currentQ.q_id,
      core_topic: currentQ.core_topic || "",
      read_ms,
      answer_ms,
      is_correct: isCorrect,
      answer_key: currentQ.answer_key,
      explanation: currentQ.explanation || "",
      user_answer: val ? "TRUE" : "FALSE",
      type: "TF",
    };

    setPendingAnswer(rec);
    setRecords((prev) => [...prev, rec]);
    setPhase("feedback");
  }

  // CARD: reveal answer -> go feedback
  function onCardReveal() {
    if (!currentQ || phase !== "answer") return;

    if (!firstActionAtRef.current) firstActionAtRef.current = nowMs();
    setCardRevealed(true);

    const read_ms = Math.max(0, (firstActionAtRef.current || nowMs()) - (questionShownAtRef.current || nowMs()));
    const answer_ms = 0;

    const rec = {
      q_id: currentQ.q_id,
      core_topic: currentQ.core_topic || "",
      read_ms,
      answer_ms,
      is_correct: true,
      answer_key: safeStr(currentQ.answer_key),
      explanation: currentQ.explanation || "",
      user_answer: "REVEALED",
      type: "CARD",
    };

    setPendingAnswer(rec);
    setRecords((prev) => [...prev, rec]);
    setPhase("feedback");
  }

  // Feedback: familiarity -> write answers + stats -> next question
  async function handleFamiliarity(choice) {
    try {
      if (!pendingAnswer || !currentQ || !sessionId || !userId || !db) return;

      const familiarity_choice = choice; // "familiar" | "needs_practice"
      const time_ms = (pendingAnswer.read_ms || 0) + (pendingAnswer.answer_ms || 0);

      // 1) write answers
      await addDoc(collection(db, "answers"), {
        session_id: sessionId,
        user_id: userId,
        user_name: userName || null,
        subject,
        q_id: currentQ.q_id,
        type: safeUpper(currentQ.type) === "TF" ? "TF" : "CARD",
        core_topic: currentQ.core_topic || null,

        user_answer: pendingAnswer.user_answer,
        is_correct: pendingAnswer.is_correct,

        familiarity_choice,
        time_ms,

        read_time_ms: pendingAnswer.read_ms,
        answer_time_ms: pendingAnswer.answer_ms,

        created_at: serverTimestamp(),
      });

      // 2) update user_question_stats
      const statId = `${userId}__${currentQ.q_id}`;
      const statRef = doc(db, "user_question_stats", statId);

      let prevAttempts = 0;
      let prevWrong = 0;

      const statSnap = await getDoc(statRef);
      if (statSnap.exists()) {
        const s = statSnap.data();
        prevAttempts = Number(s.attempts || 0);
        prevWrong = Number(s.wrong || 0);
      }

      const newAttempts = prevAttempts + 1;

      const isTF = safeUpper(currentQ.type) === "TF";
      const addWrong = isTF && !pendingAnswer.is_correct ? 1 : 0;
      const newWrong = prevWrong + addWrong;

      const needsUntil =
        familiarity_choice === "needs_practice" ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;

      await setDoc(
        statRef,
        {
          user_id: userId,
          q_id: currentQ.q_id,
          subject,
          core_topic: currentQ.core_topic || "",
          attempts: newAttempts,
          wrong: newWrong,
          last_result: isTF ? (pendingAnswer.is_correct ? "correct" : "wrong") : "n/a",
          familiarity: familiarity_choice,
          needs_practice_until: needsUntil,
          updated_at: serverTimestamp(),
        },
        { merge: true }
      );

      // 3) next question immediately
      await goNext();
    } catch (err) {
      console.log("handleFamiliarity failed:", err);
    }
  }

  async function goNext() {
    const nextIdx = idx + 1;

    if (nextIdx >= questions.length) {
      const tfRecords = records.filter((r) => r.type === "TF");
      const cc = tfRecords.filter((r) => r.is_correct).length;
      const tfCount = tfRecords.length;
      const totalMs = records.reduce((acc, r) => acc + (r.read_ms || 0) + (r.answer_ms || 0), 0);

      await setDoc(
        doc(db, "sessions", sessionId),
        {
          ended_at: serverTimestamp(),
          total_seconds: Math.round(totalMs / 1000),
          correct_count: cc,
          accuracy: tfCount ? cc / tfCount : 0,
          status: "completed",
        },
        { merge: true }
      );

      setPhase("summary");
      return;
    }

    setIdx(nextIdx);
    resetPerQuestionUI();
  }

  /** ---------- Render ---------- */
  if (!booted) {
    return (
      <main style={pageStyle}>
        <h1 style={{ fontSize: 20, fontWeight: 900 }}>準備中…</h1>
      </main>
    );
  }

  if (loading) {
    return (
      <main style={pageStyle}>
        <h1 style={{ fontSize: 20, fontWeight: 900 }}>載入中…</h1>
        <p style={{ marginTop: 8, opacity: 0.8 }}>正在抓題目與建立練習。</p>
      </main>
    );
  }

  if (!questions.length) {
    return (
      <main style={pageStyle}>
        <h1 style={{ fontSize: 20, fontWeight: 900 }}>這科目前沒有可練題</h1>
        <p style={{ marginTop: 8, opacity: 0.8 }}>
          請確認 Firestore questions 有 active=true、subject="{subject}" 且 type="TF/CARD"。
        </p>
        <button style={{ ...btnStyle, marginTop: 12 }} onClick={() => router.push("/subject")}>
          回選科目
        </button>
      </main>
    );
  }

  if (phase === "summary") {
    const tfRecords = records.filter((r) => r.type === "TF");
    const tfCorrect = tfRecords.filter((r) => r.is_correct).length;
    const tfTotal = tfRecords.length;
    const accPct = tfTotal ? Math.round((tfCorrect / tfTotal) * 100) : 0;
    const slowTop3 = topicStats.slice(0, 3);

    return (
      <main style={{ ...pageStyle, maxWidth: 720, margin: "0 auto" }}>
        <h1 style={{ fontSize: 24, fontWeight: 900 }}>總回饋 🧐</h1>

        <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
          <div style={cardStyle}>總耗時 👀：{totalSec} 秒</div>
          <div style={cardStyle}>
            問答正確率 🥳：{tfCorrect} / {tfTotal}（{accPct}%）
          </div>
        </div>

<h2 style={{ marginTop: 18, fontSize: 18, fontWeight: 900 }}> ⚠️ 最慢 3 個主題 ⚠️</h2>
<div style={{ display: "grid", gap: 10, marginTop: 10 }}>
  {slowTop3.map((t) => (
    <div key={t.core_topic} style={cardStyle}>
      <div style={{ fontWeight: 900 }}>[{t.core_topic}]</div>
      <div style={{ marginTop: 6, opacity: 0.9, lineHeight: 1.5 }}>
        總時間：{msToSec(t.total_ms)} 秒
      </div>
    </div>
  ))}
</div>

        {/* ✅ encouragement from Firestore */}
<h2 style={{ marginTop: 18, fontSize: 18, fontWeight: 900 }}>
  👊🏻 相信自己，努力會有回饋的！👊🏻
</h2>

<div style={{ ...cardStyle, marginTop: 10 }}>
  <div style={{ lineHeight: 1.7 }}>
    {encouragementText || "完成一輪很棒！保持節奏，下一輪會更穩。"}
  </div>
</div>



{DEBUG_MODE && (
  <div style={{ ...cardStyle, marginTop: 10, fontSize: 12, opacity: 0.9, lineHeight: 1.6 }}>
    <div><b>DEBUG encouragements</b></div>
    <div>count (active=true): {encourageCount}</div>
    <div>error: {encourageError || "(none)"}</div>
    <div>shown: {encouragementText}</div>
  </div>
)}

 <div style={{ display: "flex", gap: 12, marginTop: 14 }}>
  <button
    style={btnStyle}
    onClick={() => {
      // 同一科目再練一次：直接回 /practice 重新開始一輪
      router.push("/practice");
    }}
  >
    再練習 🙌🏻
  </button>

  <button style={btnStyle} onClick={() => router.push("/subject")}>
    換一科目 🧠
  </button>
</div>


        {DEBUG_MODE && (
          <div style={{ ...cardStyle, marginTop: 16, fontSize: 12, opacity: 0.8 }}>
            Debug: encouragementText = {JSON.stringify(encouragementText)}
          </div>
        )}
      </main>
    );
  }

  // answer / feedback
  const topic = currentQ.core_topic || "（未分類）";
  const qType = safeUpper(currentQ.type);
  const lastRec = records[records.length - 1];

  return (
    <main style={{ ...pageStyle, maxWidth: 720, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ opacity: 0.8 }}>
          第 {idx + 1} / {questions.length} 題
        </div>
        <div style={chipStyle}>
          <span style={{ opacity: 0.7 }}>主題</span>
          <b>{topic}</b>
        </div>
      </div>

      <div style={{ ...cardStyle, marginTop: 12 }}>
        <div style={{ fontSize: 22, fontWeight: 900, lineHeight: 1.35 }}>{currentQ.statement}</div>
      </div>

      {phase === "answer" ? (
        <>
          {qType === "TF" ? (
            <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
              <button style={btnStyle} onClick={() => onTFPick(true)}>
                ✅ 正確（True）
              </button>
              <button style={btnStyle} onClick={() => onTFPick(false)}>
                ❌ 不正確（False）
              </button>
              <div style={{ fontSize: 13, opacity: 0.75 }}>（點選後會直接顯示答案與詳解）</div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
              {!cardRevealed ? (
                <button style={btnPrimary} onClick={onCardReveal}>
                  翻面／顯示答案 →
                </button>
              ) : null}
              <div style={{ fontSize: 13, opacity: 0.75 }}>（CARD：先看正面，按「翻面」進入答案頁）</div>
            </div>
          )}

          <div style={bottomBar}>
            <button style={btnStyle} onClick={() => router.push("/subject")}>
              退出本輪（回選科目）
            </button>
          </div>
        </>
      ) : (
        <>
          {/* feedback */}
          <div style={{ ...cardStyle, marginTop: 14 }}>
            <div style={{ fontSize: 18, fontWeight: 900 }}>
              {qType === "TF" ? (lastRec?.is_correct ? "答對了 ✅" : "答錯了 ❌") : "答案頁（自我評估）"}
            </div>

            {qType === "TF" ? (
              <div style={{ marginTop: 8 }}>
                正確答案：<b>{String(currentQ.answer_key || "")}</b>
              </div>
            ) : (
              <div style={{ marginTop: 8, lineHeight: 1.6 }}>
                <b>答案/名稱</b>：{safeStr(currentQ.answer_key) || "（未填 answer_key）"}
              </div>
            )}

            {!!currentQ.explanation && (
              <div style={{ marginTop: 10, lineHeight: 1.6, fontSize: 16, opacity: 0.95, whiteSpace: "pre-wrap" }}>
                <b>詳解</b>
                {"\n"}
                {currentQ.explanation}
              </div>
            )}

            {lastRec && (
              <div style={{ marginTop: 10, fontSize: 13, opacity: 0.8, lineHeight: 1.6 }}>
                題目閱讀：{msToSec(lastRec.read_ms)} 秒｜作答/翻卡：{msToSec(lastRec.answer_ms)} 秒
                <br />
                （點下方按鈕會立即跳到下一題）
              </div>
            )}
          </div>

          <div style={bottomBar}>
            <div style={{ display: "grid", gap: 10 }}>
              <button style={btnStyle} onClick={() => handleFamiliarity("familiar")}>
                👍 熟悉（下一題）
              </button>
              <button style={btnStyle} onClick={() => handleFamiliarity("needs_practice")}>
                🔁 需要重複練習（下一題）
              </button>
              <button style={btnStyle} onClick={() => handleFamiliarity("mastered")}>
                🤩 已掌握（練過 3 次且已熟悉）
              </button>
            </div>
          </div>
        </>
      )}

      {/* 🧪 Debug 面板 */}
      {DEBUG_MODE && roundDebug?.length > 0 && (
        <div style={{ ...cardStyle, marginTop: 16 }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>🧪 Debug: Round Weights</div>

          <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.5 }}>
            weight 越高越容易被抽到（production 不顯示）。
          </div>

          <div style={{ marginTop: 10, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  {["q_id", "type", "core_topic", "weight", "att", "wrong", "wr", "fam", "prio", "force"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        borderBottom: "1px solid #e9e9ef",
                        padding: "8px 6px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {roundDebug
                  .slice()
                  .sort((a, b) => b.weight - a.weight)
                  .map((r) => (
                    <tr key={r.q_id}>
                      <td style={{ borderBottom: "1px solid #f0f1f5", padding: "8px 6px", whiteSpace: "nowrap" }}>
                        {r.q_id}
                      </td>
                      <td style={{ borderBottom: "1px solid #f0f1f5", padding: "8px 6px" }}>{r.type}</td>
                      <td style={{ borderBottom: "1px solid #f0f1f5", padding: "8px 6px" }}>{r.core_topic}</td>
                      <td style={{ borderBottom: "1px solid #f0f1f5", padding: "8px 6px" }}>
                        {Number(r.weight).toFixed(2)}
                      </td>
                      <td style={{ borderBottom: "1px solid #f0f1f5", padding: "8px 6px" }}>{r.attempts}</td>
                      <td style={{ borderBottom: "1px s olid #f0f1f5", padding: "8px 6px" }}>{r.wrong}</td>
                      <td style={{ borderBottom: "1px solid #f0f1f5", padding: "8px 6px" }}>{r.wrongRate}</td>
                      <td style={{ borderBottom: "1px solid #f0f1f5", padding: "8px 6px" }}>{r.familiarity}</td>
                      <td style={{ borderBottom: "1px solid #f0f1f5", padding: "8px 6px" }}>{r.teacher_priority}</td>
                      <td style={{ borderBottom: "1px solid #f0f1f5", padding: "8px 6px" }}>
                        {r.force_repeat ? "Y" : ""}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
