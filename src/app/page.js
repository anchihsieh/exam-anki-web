"use client";

import { useRouter } from "next/navigation";

const USERS = [
  { user_id: "chiao", name: "品蕎 🍭" },
  { user_id: "ashley", name: "妍欣 🍒" },

  // ✅ 測試用（不會影響學生權重）
  { user_id: "tester", name: "Tester (for dev)" },
];


export default function Home() {
  const router = useRouter();

  const pickUser = (u) => {
    localStorage.setItem("user_id", u.user_id);
    localStorage.setItem("user_name", u.name);
    router.push("/subject");
  };

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: 24, fontWeight: 900 }}>選擇使用者</h1>
      <p style={{ marginTop: 8, opacity: 0.8 }}>
        選好後就開始選科目。
      </p>

      <div style={{ display: "grid", gap: 12, marginTop: 16, maxWidth: 360 }}>
        {USERS.map((u) => (
          <button key={u.user_id} onClick={() => pickUser(u)} style={btnStyle}>
            {u.name}
          </button>
        ))}
      </div>
    </main>
  );
}

const pageStyle = {
  padding: 24,
  fontFamily: "system-ui",
  background: "#f6f7fb",
  minHeight: "100vh",
  color: "#111",
};

const btnStyle = {
  padding: "14px 16px",
  fontSize: 18,
  borderRadius: 12,
  border: "1px solid #ddd",
  background: "white",
  color: "#111",
  cursor: "pointer",
};
