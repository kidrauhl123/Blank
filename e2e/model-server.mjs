import http from "node:http";

if (process.env.BANKPILOT_MODEL_E2E !== "1") throw new Error("Test model server requires BANKPILOT_MODEL_E2E=1");
const models = ["bank-test-alpha", "bank-test-beta"];
http.createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/health") return response.end('{"status":"test-only"}');
  if (request.headers.authorization !== "Bearer model-e2e-only") {
    response.statusCode = 401; return response.end("{}");
  }
  if (request.url === "/v1/models" && request.method === "GET") {
    return response.end(JSON.stringify({ data: models.map(id => ({ id })) }));
  }
  if (request.url === "/v1/chat/completions" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (!models.includes(input.model)) { response.statusCode = 422; return response.end("{}"); }
    return response.end(JSON.stringify({ id: "model-selection-test", object: "chat.completion", created: 1, model: input.model,
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id: "model_question", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question: "查看哪类信息？", options: ["余额", "卡片"] }) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
  }
  response.statusCode = 404; response.end("{}");
}).listen(54230, "127.0.0.1", () => console.log("Isolated model transport listening on 54230"));
