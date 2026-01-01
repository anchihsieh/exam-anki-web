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


  // phase: "answer" | "feedback" | "summary"
  const [phase, setPhase] = useState("answer");

  // timing
  const questionShownAtRef = useRef(null); // when question page shows
  const firstActionAtRef = useRef(null);   // first click (TF pick / CARD reveal)

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

function weightedSampleNoReplace(items, k, getWeight) {
  const pool = items.map((it) => ({ it, w: Math.max(0, Number(getWeight(it)) || 0) }));
  const picked = [];
  for (let t = 0; t < k && pool.length > 0; t++) {
    const total = pool.reduce((acc, x) => acc + x.w, 0);
    // 如果全部權重都 0，就退化成隨機
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
  const needsPractice = familiarity === "needs_practice" ? 1 : 0;

  const teacherPriority = Number(q?.teacher_priority || 0);
  const forceRepeat = !!q?.force_repeat;

  // ✅ B：中等強度（不保證必出，但會明顯提高機率）
  const w =
    1 +
    4 * wrongRate +
    3 * needsPractice +
    2 * teacherPriority +
    (forceRepeat ? 2 : 0) +
    Math.random() * 0.5;

  return w;
}


  function resetPerQuestionUI() {
    questionShownAtRef.current = nowMs();
    firstActionAtRef.current = null;
    setPendingAnswer(null);
    setCardRevealed(false);
    setPhase("answer");
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

    // 1) 讀題庫（TF + CARD）
    const qRef = collection(db, "questions");
    const qy = query(
      qRef,
      where("active", "==", true),
      where("subject", "==", subject),
      limit(800)
    );
    const snap = await getDocs(qy);

    const allQ = snap.docs.map((d) => d.data()).filter((x) => x && x.q_id);

    const candidates = allQ.filter((q) => {
      const t = String(q.type || "").toUpperCase();
      return t === "TF" || t === "CARD" || t === "FLASHCARD";
    });

    // 2) 讀該使用者 stats（同科）
    const stRef = collection(db, "user_question_stats");
    const stQy = query(
      stRef,
      where("user_id", "==", userId),
      where("subject", "==", subject),
      limit(2000)
    );
    const stSnap = await getDocs(stQy);
    const statsDocs = stSnap.docs.map((d) => d.data());
    const statsMap = buildStatsMap(statsDocs);

    // 3) 保守插入：force_repeat 最多 1 題
    const forceList = candidates.filter((q) => !!q.force_repeat);
    const forced = forceList.length
      ? [forceList[Math.floor(Math.random() * forceList.length)]]
      : [];

    // 4) 其餘用權重抽滿 10 題（不重複）
    const forcedIds = new Set(forced.map((q) => q.q_id));
    const remainingPool = candidates.filter((q) => !forcedIds.has(q.q_id));

    const need = Math.max(0, 10 - forced.length);
    const weightedPicked = weightedSampleNoReplace(
      remainingPool,
      need,
      (q) => calcWeight(q, statsMap.get(String(q.q_id)))
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

  // TF: click TRUE/FALSE -> immediately go feedback (no submit button)
  function onTFPick(val) {
    if (!currentQ || phase !== "answer") return;

    if (!firstActionAtRef.current) firstActionAtRef.current = nowMs();

    // we consider: read_ms = until first click, answer_ms = 0 (since no confirm step now)
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

    // CARD 沒有「對錯」：我們先把 is_correct = true（因為是自評）
    const rec = {
      q_id: currentQ.q_id,
      core_topic: currentQ.core_topic || "",
      read_ms,
      answer_ms,
      is_correct: true,
      answer_key: safeStr(currentQ.answer_key), // 你可放「定理名稱」
      explanation: currentQ.explanation || "",   // 你可放更完整說明
      user_answer: "REVEALED",
      type: "CARD",
    };

    setPendingAnswer(rec);
    setRecords((prev) => [...prev, rec]);
    setPhase("feedback");
  }

  // Feedback: familiarity -> write answers + stats -> next question (immediately)
  async function handleFamiliarity(choice) {
    if (!pendingAnswer || !currentQ || !sessionId || !userId) return;

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

      // for TF only
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

    // For CARD we don't count wrong (it's self-learning)
    const isTF = safeUpper(currentQ.type) === "TF";
    const addWrong = isTF && !pendingAnswer.is_correct ? 1 : 0;
    const newWrong = prevWrong + addWrong;

    const needsUntil =
      familiarity_choice === "needs_practice"
        ? new Date(Date.now() + 24 * 60 * 60 * 1000) // ✅ 24h
        : null;

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
  }

  async function goNext() {
    const nextIdx = idx + 1;

    if (nextIdx >= questions.length) {
      // finish session
      const cc = records.filter((r) => r.type === "TF" && r.is_correct).length;
      const tfCount = records.filter((r) => r.type === "TF").length;
      const totalMs = records.reduce((acc, r) => acc + (r.read_ms || 0) + (r.answer_ms || 0), 0);

      await setDoc(
        doc(db, "sessions", sessionId),
        {
          ended_at: serverTimestamp(),
          total_seconds: Math.round(totalMs / 1000),
          correct_count: cc,
          accuracy: tfCount ? cc / tfCount : 0, // accuracy only counts TF
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
    const accPct = tfRecords.length ? Math.round((correctCount / tfRecords.length) * 100) : 0;
    const slowTop3 = topicStats.slice(0, 3);

    let message = "加油！完成一輪很棒。";
    if (accPct >= 85) message = "超穩！再把最慢的 3 個主題看一次解析，速度會更快。";
    else if (accPct >= 60) message = "做得不錯！先把最慢 3 個主題各整理成一句話。";
    else message = "沒關係，代表你找到弱點了。先把最慢主題重做一輪，目標錯題減半！";

    return (
      <main style={{ ...pageStyle, maxWidth: 720, margin: "0 auto" }}>
        <h1 style={{ fontSize: 24, fontWeight: 900 }}>總回饋</h1>

        <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
          <div style={cardStyle}>總耗時：{totalSec} 秒</div>
          <div style={cardStyle}>
            TF 正確：{correctCount} / {tfRecords.length}（{accPct}%）
          </div>
        </div>

        <h2 style={{ marginTop: 18, fontSize: 18, fontWeight: 900 }}>最慢 3 個主題</h2>
        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          {slowTop3.map((t) => (
            <div key={t.core_topic} style={cardStyle}>
              <div style={{ fontWeight: 900 }}>{t.core_topic}</div>
              <div style={{ marginTop: 6, opacity: 0.9, lineHeight: 1.5 }}>
                總時間：{msToSec(t.total_ms)} 秒（題目 {t.count} 題）<br />
                題目閱讀：{msToSec(t.read_ms)} 秒｜作答/翻卡：{msToSec(t.answer_ms)} 秒
              </div>
            </div>
          ))}
        </div>

        <div style={{ ...cardStyle, marginTop: 14 }}>{message}</div>

        <div style={{ display: "flex", gap: 12, marginTop: 14 }}>
          <button style={btnStyle} onClick={() => router.push("/subject")}>再練一科</button>
          <button style={btnStyle} onClick={() => router.push("/")}>換使用者</button>
        </div>
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
      <div style={{ fontSize: 22, fontWeight: 900, lineHeight: 1.35 }}>
        {currentQ.statement}
      </div>
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
            <div style={{ fontSize: 13, opacity: 0.75 }}>
              （點選後會直接顯示答案與詳解）
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
            {!cardRevealed ? (
              <button style={btnPrimary} onClick={onCardReveal}>
                翻面／顯示答案 →
              </button>
            ) : null}
            <div style={{ fontSize: 13, opacity: 0.75 }}>
              （CARD：先看正面，按「翻面」進入答案頁）
            </div>
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
            {qType === "TF"
              ? (lastRec?.is_correct ? "答對了 ✅" : "答錯了 ❌")
              : "答案頁（自我評估）"}
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
          </div>
        </div>
      </>
    )}

    {/* 🧪 Debug 面板（只在 dev 顯示） */}
{DEBUG_MODE && roundDebug?.length > 0 && (
      <div style={{ ...cardStyle, marginTop: 16 }}>
        <div style={{ fontWeight: 900, marginBottom: 8 }}>🧪 Debug: Round Weights</div>

        <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.5 }}>
          只在開發模式顯示（production 不顯示）。weight 越高越容易被抽到。
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
                    <td style={{ borderBottom: "1px solid #f0f1f5", padding: "8px 6px" }}>{r.wrong}</td>
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
