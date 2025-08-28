// vidai-proxy-t2v / index.js  (clean-t2v)
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use((req, _res, next) => {
  console.log("[INGRESS]", req.method, req.path, "ct=", req.headers["content-type"]);
  next();
});

// ==== ENV ====
const PORT = process.env.PORT || 3000;
const FAL_API_KEY = process.env.FAL_API_KEY;
// t2v default modeli (istersen Render env'de FAL_MODEL ile değiştir)
const FAL_MODEL = process.env.FAL_MODEL || "fal-ai/wan/v2.2-a14b/text-to-video/lora";
const USE_QUEUE = process.env.FAL_USE_QUEUE === "0" ? false : true;

const FAL_DIRECT = "https://fal.run";
const FAL_QUEUE  = "https://queue.fal.run";

function submitUrl(modelId) {
  return USE_QUEUE ? `${FAL_QUEUE}/${modelId}/requests` : `${FAL_DIRECT}/${modelId}`;
}
function baseModelId(modelId) {
  const p = (modelId || "").split("/");
  return p.length >= 2 ? `${p[0]}/${p[1]}` : modelId;
}
function pickVideoUrl(any) {
  const r = any?.response || any;
  const cands = [
    r?.video_url,
    r?.video?.url,
    r?.videos?.[0]?.url,
    r?.output?.[0]?.url,
    r?.data?.video_url,
    r?.media?.[0]?.url,
  ].filter(Boolean);
  return cands[0] || null;
}

async function falPostJSONSubmit(modelId, body) {
  const url = submitUrl(modelId);
  const headers = { Authorization: `Key ${FAL_API_KEY}`, "Content-Type": "application/json" };

  console.log("[FAL SUBMIT]", { url, modelId, use_queue: USE_QUEUE, body });
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    console.error("[FAL SUBMIT ERR]", res.status, txt?.slice?.(0, 200));
    throw new Error(`Fal HTTP ${res.status} ${txt}`);
  }
  try { return JSON.parse(txt); } catch { return { response: txt }; }
}

app.get("/healthz", (_req, res) => res.json({
  ok: true, service: "t2v", version: "clean-t2v", model: FAL_MODEL, use_queue: USE_QUEUE
}));
app.get("/", (_req, res) => res.send("OK t2v"));

app.get("/test-t2v", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <h3>Text → Video</h3>
    <form method="POST" action="/video/generate_text">
      <div>Prompt: <input name="prompt" style="width:400px" value="a cat dancing on the street, cinematic"/></div>
      <button type="submit">Submit</button>
    </form>
  `);
});

// === Generate (text -> video)
app.post("/video/generate_text", async (req, res) => {
  try {
    const prompt = (req.body.prompt || "").trim();
    console.log("[T2V IN] prompt len:", prompt.length);
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    const payload = { input: { prompt } };
    const data = await falPostJSONSubmit(FAL_MODEL, payload);

    if (USE_QUEUE) {
      console.log("[T2V QUEUED]", { request_id: data.request_id, status_url: data.status_url });
      return res.json({
        request_id:   data.request_id,
        status_url:   data.status_url,
        response_url: data.response_url
      });
    } else {
      const video_url = pickVideoUrl(data);
      return res.json({ video_url, raw: data });
    }
  } catch (e) {
    console.error("[T2V ERROR]", e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// === Result (poll)
app.get("/video/result/:id?", async (req, res) => {
  try {
    const headers = { Authorization: `Key ${FAL_API_KEY}` };
    const statusUrl = req.query.status_url;

    let statusResp, statusUrlUsed = null;
    if (statusUrl) {
      statusUrlUsed = statusUrl;
      console.log("[RESULT] via status_url:", statusUrl);
      statusResp = await fetch(statusUrl, { headers });
    } else {
      const id = req.params.id;
      if (!id) return res.status(400).json({ error: "status_url or id required" });
      const url = `${FAL_QUEUE}/${baseModelId(FAL_MODEL)}/requests/${id}/status`;
      statusUrlUsed = url;
      console.log("[RESULT] via id:", id, " url:", url);
      statusResp = await fetch(url, { headers });
    }

    const statusTxt = await statusResp.text().catch(() => "");
    if (!statusResp.ok) {
      console.error("[RESULT ERR]", statusResp.status, statusTxt?.slice?.(0, 200));
      return res.status(statusResp.status).send(statusTxt || "error");
    }

    let statusData; try { statusData = JSON.parse(statusTxt); } catch { statusData = { response: statusTxt }; }
    const status = statusData?.status || statusData?.response?.status || "";
    let video_url = pickVideoUrl(statusData);

    const done = (s) => ["COMPLETED","SUCCEEDED","succeeded","completed"].includes((s||"").toUpperCase());
    if (done(status) && !video_url) {
      const respUrl =
        statusData?.response_url ||
        statusData?.response?.response_url ||
        (statusUrlUsed?.endsWith("/status") ? statusUrlUsed.replace(/\/status$/, "") : null);

      if (respUrl) {
        console.log("[RESULT] fetch response_url:", respUrl);
        const r2 = await fetch(respUrl, { headers });
        const txt2 = await r2.text().catch(() => "");
        if (!r2.ok) {
          console.error("[RESULT RESP ERR]", r2.status, txt2?.slice?.(0, 200));
          return res.status(r2.status).send(txt2 || "error");
        }
        let respData; try { respData = JSON.parse(txt2); } catch { respData = { response: txt2 }; }
        const resolvedUrl = pickVideoUrl(respData);
        if (resolvedUrl) video_url = resolvedUrl;
        return res.json({ status, video_url, raw: respData });
      }
    }

    return res.json({ status, video_url, raw: statusData });
  } catch (e) {
    console.error("[RESULT ERROR]", e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("t2v server on:", PORT, { model: FAL_MODEL, USE_QUEUE });
});
