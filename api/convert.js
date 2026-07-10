// api/convert.js
// Vercel Serverless Function (Node.js runtime).
// Replaces the Cloudflare Worker. Region is pinned via vercel.json,
// so requests to Anthropic never get routed through a blocked region (e.g. Hong Kong).

const RATE_LIMIT_MAX = 12;
const RATE_LIMIT_WINDOW_SECONDS = 3 * 60 * 60; // 3시간

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*"); // 배포 후 아임웹 도메인으로 제한 권장
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ---- Upstash Redis REST helpers ----
// Upstash REST API: https://<UPSTASH_REDIS_REST_URL>/<COMMAND>/<args...>
async function upstash(command) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  const url = base + "/" + command.map(encodeURIComponent).join("/");
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + token }
  });
  const data = await res.json();
  return data.result;
}

async function incrKey(key) {
  return upstash(["INCR", key]);
}

async function decrKey(key) {
  return upstash(["DECR", key]);
}

async function expireKey(key, seconds) {
  return upstash(["EXPIRE", key, String(seconds)]);
}

async function ttlKey(key) {
  return upstash(["TTL", key]);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    setCors(res);
    res.status(405).json({ error: "POST 요청만 허용됩니다." });
    return;
  }

  setCors(res);

  // ===== 사용량 제한: IP당 3시간에 12회 =====
  const clientIP =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const rateKey = "rl:" + clientIP;

  let currentCount = 0;
  let rateLimitOk = true;

  try {
    currentCount = await incrKey(rateKey);
    if (currentCount === 1) {
      await expireKey(rateKey, RATE_LIMIT_WINDOW_SECONDS);
    }
    if (currentCount > RATE_LIMIT_MAX) {
      rateLimitOk = false;
    }
  } catch (e) {
    // Redis 실패해도 서비스는 계속 진행 (제한 없이 통과)
    rateLimitOk = true;
  }

  if (!rateLimitOk) {
    let resetInMinutes = 1;
    try {
      const ttl = await ttlKey(rateKey);
      if (typeof ttl === "number" && ttl > 0) {
        resetInMinutes = Math.ceil(ttl / 60);
      }
    } catch (e) {
      // ignore
    }

    res.status(429).json({
      error:
        "사용 횟수를 다 사용하셨습니다. 약 " + resetInMinutes + "분 후 다시 이용해주세요.",
      remaining: 0,
      limit: RATE_LIMIT_MAX
    });
    return;
  }

  const remainingAfterThis = Math.max(RATE_LIMIT_MAX - currentCount, 0);

  // 실패(오류) 시 방금 차감한 1회를 되돌려주는 함수
  async function refundUsage() {
    try {
      await decrKey(rateKey);
    } catch (e) {
      // 환불 실패해도 서비스는 계속 진행
    }
  }
  // ===== 사용량 제한 로직 끝 =====

  try {
    const { image, mediaType } = req.body || {};

    if (!image || !mediaType) {
      await refundUsage();
      res.status(400).json({ error: "image, mediaType이 필요합니다." });
      return;
    }

    const conversionRule = `당신은 기타 코드 변환 전문가입니다. 이미지 속 악보를 분석해서 곡 전체의 조성(key)을 
판단하고, 아래 규칙에 따라 코드를 변환하세요.

[1단계: 조성 판단 방법 - 아래 순서대로 시도]
1. 오선보(악보)에 조표(key signature, 플랫/샵 개수)가 표시되어 있다면, 
   그 조표를 기준으로 곡의 조성을 판단하세요.
2. 오선보 없이 코드만 나열된 악보라면, 다음 요소들을 종합적으로 참고해서 
   실제 조성을 판단하세요:
   - 첫 번째로 등장하는 코드
   - 전체 코드 진행에서 가장 자주 등장하는 코드
   - 곡이 시작되거나 종결(마무리)되는 코드
   이 요소들을 함께 고려해서 곡의 중심 코드(tonic)와 조성을 판단하세요.
   첫 코드 하나만으로 단정하지 말고, 전체 흐름과 함께 판단하세요.
3. 악보에 "원곡 Key: OO" 같은 텍스트 정보가 적혀 있어도 그것은 절대 참고하지 
   마세요. 반드시 조표나 실제 코드 진행 분석을 통해서만 조성을 판단하세요.

[2단계: 곡의 조성에 따른 이동값(반음) 결정]

메이저 조성:
- C → 이동값 3 (A로 변환)
- C#, Db → 예외 케이스: 이동값 1(C로 변환)과 이동값 4(A로 변환) 두 가지를 모두 계산
- D → 이동값 0 (유지)
- D#, Eb → 이동값 1 (D로 변환)
- E → 이동값 0 (유지)
- F → 이동값 1 (E로 변환)
- F#, Gb → 이동값 2 (E로 변환)
- G → 이동값 0 (유지)
- G#, Ab → 이동값 1 (G로 변환)
- A → 이동값 0 (유지)
- A#, Bb → 이동값 1 (A로 변환)
- B → 이동값 2 (A로 변환)

마이너 조성:
- Cm → 이동값 1 (Bm으로 변환)
- C#m, Dbm → 이동값 0 (유지)
- Dm → 이동값 0 (유지)
- D#m, Ebm → 이동값 1 (Dm으로 변환)
- Em → 이동값 0 (유지)
- Fm → 이동값 1 (Em으로 변환)
- F#m, Gbm → 이동값 0 (유지)
- Gm → 이동값 1 (F#m으로 변환)
- G#m, Abm → 이동값 0 (유지)
- Am → 이동값 0 (유지)
- A#m, Bbm → 이동값 1 (Am으로 변환)
- Bm → 이동값 0 (유지)

카포 위치 = 이동값(반음 수)과 동일한 프렛 번호. 이동값 0이면 카포 불필요.

[3단계: 이동값 적용 - 매우 중요한 원칙]
- 위 표는 오직 "곡 전체의 조성이 무엇인지 판단"할 때만 사용합니다.
- 일단 곡의 조성이 확정되고 이동값이 정해지면, 그 이동값을 악보에 등장하는 
  모든 개별 코드에 예외 없이 동일하게 적용해서 일괄 이조하세요.
- 이동값이 0이 아닌 조성의 곡이라면, 그 악보 안에 등장하는 코드가 설령 
  위 표에서 "유지 대상(D, E, G, A, Dm, Em, Am, Bm 등)"으로 분류된 코드여도 
  예외 없이 곡 전체의 이동값만큼 함께 이조합니다.
  예: Bb 조성 곡(이동값 1) 안에 A 코드가 등장하면, A도 반음 1 내려서 
      G#(Ab)로 변환합니다.
- 이동값이 0인 조성(곡 자체가 유지 대상 조성)인 경우에만, 악보 전체를 
  그대로 두고 어떤 코드도 변환하지 않습니다.
- 슬래시 코드(예: F/A, Bb/D)는 슬래시 왼쪽 코드와 오른쪽 베이스음을 
  각각 동일한 이동값만큼 이동시켜서 새 슬래시 코드로 만드세요.
  예: 이동값 1일 때 Bb/D → A/C#

[4단계: 출력 형식]
- 중요: 1~3단계의 조성 판단과 이동값 계산은 반드시 내부적으로 정확하게 순서대로 
  수행해야 합니다. 이후의 모든 코드 변환은 이 판단 결과에 의존하므로, 조성 판단을 
  대충 하거나 생략하면 안 됩니다. 다만 그 판단 과정과 근거 자체는 최종 답변에 
  출력하지 마세요 (내부적으로만 사용). 가사도 출력하지 마세요.

- 표기 규칙: 마이너 코드는 항상 샵(#) 계열로 표기하세요.
  플랫 표기(Dbm, Ebm, Gbm, Abm, Bbm)는 사용하지 말고
  각각 C#m, D#m, F#m, G#m, A#m으로 통일해서 출력하세요.
  이 표기 규칙은 조성 판단(내부 계산)과는 무관하며, 오직 최종 출력 시
  코드 이름 표기에만 적용합니다.

- 예외 규칙 (먼저 확인): 곡 전체의 조성이 이동값 0인 경우 
  (D, E, G, A, Dm, Em, F#m, G#m, Am, Bm, C#m 중 하나로 판단된 경우), 
  아래 두 항목을 전부 생략하고 다음 한 줄만 출력하세요:
  "야매코드로 연주 가능한 악보 입니다."
  이 경우 카포 안내 문장이나 코드 변환 목록은 절대 출력하지 마세요.

- 이동값이 0이 아닌 조성(카포가 필요한 곡)이라면, 아래 두 가지만 이 순서 그대로 출력하세요.

1. 카포 안내 (자연스러운 안내 문장으로)
   - 카포가 필요하면: "카포를 O번 프렛에 끼우고 연주하세요."
   - C#/Db 조성인 경우에는 이 항목을 별도로 쓰지 말고, 아래 2번 코드 변환 목록의
     맨 앞에 있는 안내 문장("카포를 1번 또는 4번 프렛, 두 가지 방법으로 연주할 수 있습니다.")
     하나로 대체하세요. 즉 C#/Db일 때는 1번 항목을 생략하고 2번부터 바로 시작합니다.

2. 코드 변환 목록
   - "원래코드 → 변환코드" 형식으로 한 줄에 하나씩, 화살표(→)로 표시하세요.
   - 악보에 코드가 처음 등장한 순서대로 나열하세요.
   - 이미 목록에 나온 코드가 이후 다시 등장해도 중복해서 추가하지 마세요.
   - 슬래시 코드(F/A 등)는 기본 코드와 별개의 개별 항목으로 목록에 포함하세요.
   - C#/Db 조성인 경우에만, 모든 코드에 대해 옵션1(이동값1)과 옵션2(이동값4)의 결과를
     아래 형식 그대로 "카포 1번 프렛"과 "카포 4번 프렛" 두 세트로 나누어 각각 따로 출력하세요
     (한 줄에 "코드 → 옵션1 / 옵션2" 형태로 합쳐서 쓰지 마세요, 괄호로 "C로 변환"/"A로 변환" 같은
     부가 설명은 제목에 붙이지 마세요):

     카포를 1번 또는 4번 프렛, 두 가지 방법으로 연주할 수 있습니다.

     카포 1번 프렛

     원래코드1 → 변환코드1
     원래코드2 → 변환코드2
     ...

     ---

     카포 4번 프렛

     원래코드1 → 변환코드1
     원래코드2 → 변환코드2
     ...

다른 설명, 제목, 인사말 없이 위 규칙에 따른 결과만 출력하세요.`;

    async function callClaude() {
      return fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 1500,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
                { type: "text", text: conversionRule }
              ]
            }
          ]
        })
      });
    }

    // 리전이 고정되어 있어서 원래 문제(홍콩 우회)는 거의 발생하지 않지만,
    // 일시적 네트워크 오류 대비용으로 짧게 재시도는 유지합니다.
    let response = await callClaude();
    let retries = 0;
    while (response.status === 403 && retries < 2) {
      retries += 1;
      await new Promise((r) => setTimeout(r, 400 * retries));
      response = await callClaude();
    }

    if (!response.ok) {
      const errText = await response.text();
      await refundUsage();
      res.status(response.status).json({ error: "API 호출 실패", detail: errText });
      return;
    }

    const data = await response.json();

    // 디버깅용 로그: Vercel Logs에서 실제 응답 구조를 확인할 수 있도록 남김
    console.log("Anthropic response stop_reason:", data.stop_reason);
    console.log("Anthropic response content:", JSON.stringify(data.content));

    let resultText;
    if (data.content && data.content[0] && data.content[0].text) {
      resultText = data.content[0].text;
    } else if (data.stop_reason === "refusal") {
      resultText = "죄송해요, 이 악보는 분석할 수 없습니다. (저작권 관련 안전장치로 인한 거부)";
    } else {
      resultText = "변환 실패: 응답을 읽을 수 없습니다. (stop_reason: " + data.stop_reason + ")";
    }

    res.status(200).json({
      result: resultText,
      remaining: remainingAfterThis,
      limit: RATE_LIMIT_MAX
    });
  } catch (err) {
    await refundUsage();
    res.status(500).json({ error: err.message });
  }
};
