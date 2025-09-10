// /api/rss.mjs  — Vercel Node.js Serverless Function (ESM)
export default async function handler(req, res) {
  try {
    const url = req.query?.url || req.url?.split("?url=")[1];
    if (!url) {
      res.status(400).json({ error: "Missing ?url=" });
      return;
    }

    // RSS XML 가져오기
    const r = await fetch(decodeURIComponent(url), {
      headers: { "user-agent": "Mozilla/5.0 (Chatbot RSS fetcher)" },
    });
    if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
    const xml = await r.text();

    // RSS/Atom 파싱
    const { XMLParser } = await import("fast-xml-parser");
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      removeNSPrefix: true,
    });
    const data = parser.parse(xml);

    // RSS2.0
    let items = [];
    if (data?.rss?.channel?.item) {
      items = Array.isArray(data.rss.channel.item)
        ? data.rss.channel.item
        : [data.rss.channel.item];
    }
    // Atom
    else if (data?.feed?.entry) {
      items = Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry];
    }

    const normalized = items.map((it) => {
      const title =
        it?.title?.["#text"] || it?.title || "";
      const link =
        it?.link?.href || (Array.isArray(it?.link) ? it.link[0]?.href : it?.link) || it?.guid || "";
      const content =
        it?.["content:encoded"] ||
        it?.content?.["#text"] ||
        it?.description ||
        "";
      const pubDate = it?.pubDate || it?.published || it?.updated || "";
      return { title, link, content, pubDate };
    });

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate");
    res.status(200).json({ items: normalized });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
