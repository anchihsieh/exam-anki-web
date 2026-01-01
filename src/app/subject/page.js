"use client";

import { useRouter } from "next/navigation";

const subjects = [
  { key: "physics", label: "物理 Physics" },
  { key: "chemistry", label: "化學 Chemistry" },
  { key: "biology", label: "生物 Biology" },
  { key: "earth", label: "地科 Earth" },
];

export default function SubjectPage() {
  const router = useRouter();

  const pickSubject = (s) => {
    localStorage.setItem("subject", s);
    router.push("/practice");
  };

  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24, fontWeight: 800 }}>選擇科目</h1>

      <div style={{ display: "grid", gap: 12, marginTop: 16, maxWidth: 420 }}>
        {subjects.map((s) => (
          <button key={s.key} onClick={() => pickSubject(s.key)} style={btnStyle}>
            {s.label}
          </button>
        ))}
      </div>
    </main>
  );
}
const btnStyle = {
  padding: "14px 16px",
  fontSize: 18,
  borderRadius: 12,
  border: "1px solid #ddd",
  background: "white",
  color: "#111",
  cursor: "pointer",
  textAlign: "left",
};
