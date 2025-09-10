// /api/ask.mjs  — LLM 답변 생성 (RAG)
// 클라이언트에서 보내준 상위 문단(context)만 근거로 답하게 제한
import OpenAI from "openai";

export default async function handler(req, res) {
  try {
    const method = req.method || (req.body ? "POST" : "GET");
    if (method !== "POST") {
      res.status(405).json({ error: "Use POST" });
      return;
    }

    const chunksizeLimit = 8000; // 토큰 초과 방지용 대략 길이 가드
    const { question, contexts } = req.body || {};
    if (!question || !Array.isArray(contexts)) {
      res.status(400).json({ error: "Missing {question, contexts[]}" });
      return;
    }

    // context를 간단히 정리 (필요한 필드만)
    // contexts: [{ text, url, title }]
    const limited = [];
    let acc = 0;
    for (const c of contexts) {
      const t = (c.text || "").slice(0, 1500);
      const item = { text: t, url: c.url || "", title: c.title || "" };
      const len = JSON.stringify(item).length;
      if (acc + len > chunksizeLimit) break;
      limited.push(item);
      acc += len;
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const system = `
너는 의료/건강 블로그의 "제공된 발췌(contexts)"만 근거로 한국어로 대답하는 조수다.
규칙:
- 제공된 발췌 외의 지식은 사용 금지(추측 금지).
- 확실치 않으면 "지식베이스에 근거가 부족합니다"라고 말하고, 관련 원문 링크를 안내.
- 핵심 요점 → 항목으로 간결히.
- 가능하면 근거 문단마다 [각주] 형태로 〔1〕, 〔2〕… 인덱스 표기.
- 마지막에 "관련 링크" 목록을 번호와 함께 제공.
- 응급/주의 신호가 보이면 의료기관 방문 권고 문구를 덧붙여라.
`;

    const user = {
      role: "user",
      content: JSON.stringify({
        question,
        contexts: limited, // [{text, url, title}]
      })
    };

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",   // 가볍고 빠른 모델. 필요시 상위 모델로 변경 가능
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        user
      ]
    });

    const answer = completion.choices?.[0]?.message?.content || "답변 생성 실패";

    // 응답 그대로 반환 (클라이언트가 이미 어떤 문단을 보냈는지 알고 있으므로,
    // 링크 목록은 클라이언트가 contexts에서 재구성 가능)
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ answer, used: limited });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
}
