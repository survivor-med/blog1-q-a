import React, { useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { v4 as uuidv4 } from "uuid";
import { Search, Upload, Trash2, Link as LinkIcon, Save, Download } from "lucide-react";

/**
 * 블로그 기반 Q&A 챗봇 – 단일 파일 React 앱
 * -------------------------------------------------
 * ✅ 기능
 * 1) 로컬 지식베이스(블로그 글) 등록/편집/삭제 (브라우저 localStorage 저장)
 * 2) 질문 입력 → TF-IDF 유사도 기반으로 관련 문단 추출 → 발췌 요약 + 관련 링크
 * 3) JSON 내보내기/불러오기 (백업/이전)
 * 4) 한국어 UI, 모바일 대응, 미니멀 디자인
 *
 * ⚠️ 본 앱은 100% 클라이언트에서 동작(정적 호스팅 가능). 대규모 데이터나 고도화가 필요하면
 *    추후 백엔드(RSS 수집, 벡터DB, RAG) 연동 권장.
 */

const STORAGE_KEY = "blog_qa_kb_v1";

function tokenizeKorean(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[\n\r]/g, " ")
    .replace(/[^a-z0-9가-힣\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function chunkText(text, opts = { maxLen: 420, overlap: 60 }) {
  const { maxLen, overlap } = opts;
  const sents = (text || "").replace(/\s+/g, " ").split(/(?<=[.!?\n]|[다요요.]\s)/);
  const chunks = [];
  let buf = "";
  for (let i = 0; i < sents.length; i++) {
    const s = sents[i];
    if ((buf + s).length > maxLen) {
      if (buf.trim()) chunks.push(buf.trim());
      const tail = buf.slice(Math.max(0, buf.length - overlap));
      buf = tail + s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

function uniqueBy(arr, key) {
  const seen = new Set();
  return arr.filter((x) => (seen.has(x[key]) ? false : seen.add(x[key])));
}

function buildTfIdfIndex(docs) {
  const N = docs.length || 1;
  const docTokens = new Map();
  const df = new Map();

  docs.forEach((d) => {
    const tokens = tokenizeKorean(d.text);
    const tf = new Map();
    tokens.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    docTokens.set(d.id, { tf, len: tokens.length });

    const uniq = new Set(tokens);
    uniq.forEach((t) => df.set(t, (df.get(t) || 0) + 1));
  });

  function score(query) {
    const qTokens = tokenizeKorean(query);
    const qtf = new Map();
    qTokens.forEach((t) => qtf.set(t, (qtf.get(t) || 0) + 1));
    const qLen = qTokens.length || 1;

    const qWeight = new Map();
    qTokens.forEach((t) => {
      const idf = Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
      qWeight.set(t, (qtf.get(t) / qLen) * idf);
    });

    const results = [];
    docs.forEach((d) => {
      const dt = docTokens.get(d.id);
      if (!dt) return;
      let s = 0;
      qWeight.forEach((qw, t) => {
        const tf = (dt.tf.get(t) || 0) / (dt.len || 1);
        const idf = Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
        s += qw * tf * idf;
      });
      results.push({ id: d.id, score: s, meta: d.meta });
    });

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  return { score };
}

function extractKeySentences(text, query, max = 3) {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?]|[다요]\.)\s+/)
    .filter((s) => s && s.trim().length > 0);
  const qTokens = new Set(tokenizeKorean(query));
  const ranked = sentences
    .map((s) => {
      const toks = new Set(tokenizeKorean(s));
      const overlap = [...qTokens].filter((t) => toks.has(t)).length;
      return { s, overlap, len: s.length };
    })
    .sort((a, b) => (b.overlap - a.overlap) || (a.len - b.len));
  return ranked.slice(0, max).map((r) => r.s.trim());
}

export default function App() {
  const [kb, setKb] = useState(() => loadKB());
  const [query, setQuery] = useState("");
  const [chat, setChat] = useState([]);
  const [activeTab, setActiveTab] = useState("chat");

  const chunks = useMemo(() => {
    const out = [];
    kb.forEach((doc) => {
      const cs = chunkText(doc.content);
      cs.forEach((c, idx) => {
        out.push({
          id: `${doc.id}::${idx}`,
          text: c,
          meta: { title: doc.title, url: doc.url, docId: doc.id, chunkIndex: idx },
        });
      });
    });
    return out;
  }, [kb]);

  const index = useMemo(() => buildTfIdfIndex(chunks), [chunks]);

  function handleAsk(q) {
    const question = (q ?? query).trim();
    if (!question) return;

    const scored = index.score(question).slice(0, 8);
    const answers = [];
    const refs = [];
    for (const r of scored) {
      const ch = chunks.find((c) => c.id === r.id);
      if (!ch) continue;
      const keySents = extractKeySentences(ch.text, question, 2);
      if (keySents.length) {
        answers.push(`• ${keySents.join(" ")}`);
        refs.push({ url: ch.meta.url, title: ch.meta.title });
      }
      if (answers.length >= 6) break;
    }

    const uniqRefs = uniqueBy(refs.filter((r) => r.url), "url").slice(0, 5);

    const assistantText = answers.length
      ? `질문 요지: ${question}\n\n추천 답변(발췌 요약)\n${answers.join("\n")}\n\n관련 블로그 링크:\n${uniqRefs
          .map((r, i) => `${i + 1}. ${r.title || r.url} — ${r.url}`)
          .join("\n")}`
      : `현재 지식베이스에서 관련 내용을 찾지 못했어요.\n\n팁: 관리자 탭에서 블로그 글을 추가하거나, 질문을 더 구체적으로 바꿔보세요.`;

    setChat((prev) => [
      ...prev,
      { role: "user", text: question },
      { role: "assistant", text: assistantText, refs: uniqRefs },
    ]);
    setQuery("");
    setActiveTab("chat");
  }

  function handleAddDoc({ title, url, content }) {
    const next = [
      { id: uuidv4(), title: title?.trim() || "제목 없음", url: (url || "").trim(), content: content || "" },
      ...kb,
    ];
    setKb(next);
    saveKB(next);
  }

  function handleDeleteDoc(id) {
    const next = kb.filter((d) => d.id !== id);
    setKb(next);
    saveKB(next);
  }

  function handleExport() {
    const blob = new Blob([JSON.stringify(kb, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `blog_kb_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
  }

  function handleImport(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(String(e.target?.result || "[]"));
        if (Array.isArray(data)) {
          const normalized = data.map((d) => ({
            id: d.id || uuidv4(),
            title: d.title || "제목 없음",
            url: d.url || "",
            content: d.content || "",
          }));
          const next = [...normalized, ...kb];
          setKb(next);
          saveKB(next);
        } else {
          alert("JSON 형식이 올바르지 않습니다. 배열이어야 합니다.");
        }
      } catch (err) {
        alert("불러오기에 실패했습니다. JSON을 확인해주세요.");
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} className="w-9 h-9 rounded-2xl bg-gray-900 text-white grid place-items-center text-lg font-bold">Q</motion.div>
            <div>
              <h1 className="text-lg font-semibold">블로그 기반 Q&A 챗봇</h1>
              <p className="text-xs text-gray-500">지식베이스에 넣은 글만 근거로 답해요 · 결과에 원문 링크 제공</p>
            </div>
          </div>
          <nav className="flex gap-2 text-sm">
            <button onClick={() => setActiveTab("chat")} className={`px-3 py-1.5 rounded-full ${activeTab === "chat" ? "bg-gray-900 text-white" : "bg-gray-200"}`}>챗봇</button>
            <button onClick={() => setActiveTab("admin")} className={`px-3 py-1.5 rounded-full ${activeTab === "admin" ? "bg-gray-900 text-white" : "bg-gray-200"}`}>관리자</button>
            <button onClick={() => setActiveTab("kb")} className={`px-3 py-1.5 rounded-full ${activeTab === "kb" ? "bg-gray-900 text-white" : "bg-gray-200"}`}>지식베이스</button>
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {activeTab === "chat" && (
          <ChatPanel
            query={query}
            setQuery={setQuery}
            onAsk={handleAsk}
            chat={chat}
          />
        )}
        {activeTab === "admin" && (
          <AdminPanel onAdd={handleAddDoc} onImport={handleImport} onExport={handleExport} />
        )}
        {activeTab === "kb" && (
          <KBPanel kb={kb} onDelete={handleDeleteDoc} />
        )}
      </main>

      <footer className="max-w-5xl mx-auto px-4 py-8 text-xs text-gray-500">
        <p>⚠️ 본 도구는 참고용입니다. 의학/건강 관련 답변은 항상 최신 가이드라인과 전문적 판단을 병행하세요.</p>
      </footer>
    </div>
  );
}

function ChatPanel({ query, setQuery, onAsk, chat }) {
  const inputRef = useRef(null);
  return (
    <div className="grid gap-4">
      <div className="rounded-2xl border bg-white p-4 shadow-sm">
        <label className="text-sm text-gray-600">질문하기</label>
        <div className="mt-2 flex items-center gap-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) onAsk(); }}
            placeholder="예) 입덧이 20주 이후 계속되면 위험한가요?"
            className="flex-1 rounded-xl border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
          <button onClick={() => onAsk()} className="inline-flex items-center gap-2 rounded-xl bg-gray-900 text-white px-3 py-2">
            <Search className="w-4 h-4"/> 질문
          </button>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-0 overflow-hidden">
        <div className="px-4 py-3 border-b bg-gray-50 text-sm text-gray-500">대화</div>
        <div className="p-4 max-h-[60vh] overflow-auto space-y-4">
          {chat.length === 0 && (
            <div className="text-sm text-gray-500">아직 대화가 없습니다. 위 입력창에 질문을 적고 Enter를 눌러보세요.</div>
          )}
          {chat.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`${m.role === 'user' ? 'bg-gray-900 text-white' : 'bg-gray-100'} max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm`}>{m.text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AdminPanel({ onAdd, onImport, onExport }) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [rssUrl, setRssUrl] = useState("");     // ⬅️ 추가
  const [loadingRSS, setLoadingRSS] = useState(false); // ⬅️ 추가
  const fileInputRef = useRef(null);

  // RSS 불러오기 로직 ⬇️
  async function importFromRSS() {
    if (!rssUrl.trim()) {
      alert("RSS 주소를 입력해주세요.");
      return;
    }
    try {
      setLoadingRSS(true);
      const res = await fetch(`/api/rss?url=${encodeURIComponent(rssUrl.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "RSS fetch failed");

      const items = Array.isArray(data.items) ? data.items : [];
      if (items.length === 0) {
        alert("RSS에서 항목을 찾지 못했습니다.");
        return;
      }

      // HTML 태그 제거용 간단 함수
      const stripHtml = (html) => {
        const el = document.createElement("div");
        el.innerHTML = html || "";
        return el.textContent || el.innerText || "";
      };

      // 상위 20개만 추가 (너무 많을 수 있으니)
      const picked = items.slice(0, 20);
      picked.forEach((it) => {
        onAdd({
          title: it.title || "제목 없음",
          url: it.link || "",
          content: stripHtml(it.content || ""),
        });
      });

      alert(`${picked.length}개 글을 지식베이스에 추가했습니다.`);
    } catch (e) {
      console.error(e);
      alert("RSS 불러오기에 실패했습니다. RSS 주소를 다시 확인해주세요.");
    } finally {
      setLoadingRSS(false);
    }
  }

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="rounded-2xl border bg-white p-4 shadow-sm">
        <h2 className="text-base font-semibold flex items-center gap-2"><Upload className="w-4 h-4"/> 블로그 글 추가</h2>
        <p className="text-xs text-gray-500 mt-1">블로그 내용을 복붙하거나, 제목/URL을 입력해 보관하세요. URL은 선택사항입니다.</p>
        <div className="mt-4 grid gap-2">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="제목" className="rounded-xl border px-3 py-2 text-sm"/>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="원문 URL (선택)" className="rounded-xl border px-3 py-2 text-sm"/>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="본문 내용 붙여넣기" rows={10} className="rounded-xl border px-3 py-2 text-sm"/>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setTitle(""); setUrl(""); setContent(""); }} className="px-3 py-2 text-sm rounded-xl bg-gray-100">초기화</button>
            <button onClick={() => { onAdd({ title, url, content }); setTitle(""); setUrl(""); setContent(""); }} className="px-3 py-2 text-sm rounded-xl bg-gray-900 text-white">추가</button>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-4 shadow-sm">
        <h2 className="text-base font-semibold flex items-center gap-2"><Save className="w-4 h-4"/> 지식베이스 불러오기/내보내기 + RSS</h2>
        <p className="text-xs text-gray-500 mt-1">JSON 파일 백업/이동, RSS 주소에서 새 글 자동 수집(수동 실행)</p>

        {/* JSON 백업/복원 */}
        <div className="mt-4 flex items-center gap-2">
          <button onClick={() => onExport()} className="px-3 py-2 text-sm rounded-xl bg-gray-100 inline-flex items-center gap-2"><Download className="w-4 h-4"/> 내보내기</button>
          <input ref={fileInputRef} type="file" accept="application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.currentTarget.value = ""; }}/>
          <button onClick={() => fileInputRef.current?.click()} className="px-3 py-2 text-sm rounded-xl bg-gray-900 text-white">불러오기</button>
        </div>

        {/* RSS 불러오기 */}
        <div className="mt-6 grid gap-2">
          <input
            value={rssUrl}
            onChange={(e) => setRssUrl(e.target.value)}
            placeholder="RSS 주소 입력 (예: https://블로그주소/rss, https://rss.blog.naver.com/아이디.xml)"
            className="rounded-xl border px-3 py-2 text-sm"
          />
          <button
            onClick={importFromRSS}
            disabled={loadingRSS}
            className="px-3 py-2 text-sm rounded-xl bg-gray-900 text-white disabled:opacity-60"
          >
            {loadingRSS ? "불러오는 중..." : "RSS에서 불러오기"}
          </button>
        </div>

        <div className="mt-4 text-xs text-gray-500">
          <p>불러오기 JSON 형식 예시:</p>
          <pre className="bg-gray-50 p-3 rounded-xl overflow-auto text-[11px]">
{`[
  { "title": "입덧 관리 A to Z", "url": "https://example.com/nausea", "content": "..." }
]`}
          </pre>
        </div>
      </div>
    </div>
  );
}
