import assert from "node:assert/strict";
import test from "node:test";
import { extractAttachments, reasoningOf } from "../adapters/common.js";
import { langchainCallback } from "../adapters/langchain.js";
import { instrumentOpenAI } from "../adapters/openai.js";
import { Client } from "../core/client.js";

process.env.GGATE_AGENT_NAME ??= "Test Agent";
process.env.GGATE_TEAM ??= "Test Team";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(80, 7)]);
const PDF = Buffer.from("%PDF-1.4 secret document ".repeat(5));
const dataUrl = (mime: string, raw: Buffer) => `data:${mime};base64,${raw.toString("base64")}`;

class FakeTransport {
  requests: Record<string, any>[] = [];
  async request(request: Record<string, any>) {
    this.requests.push(request);
    return { kind: "verdict", verdict: "pass", message: "allowed" };
  }
}

function client() {
  const transport = new FakeTransport();
  return { transport, sdk: new Client({ mode: "sync", captureFileText: true } as any, transport as any) };
}

test("OpenAI chat and Responses parts become attachments with content", () => {
  const { sdk } = client();
  const found = extractAttachments([
    { type: "image_url", image_url: { url: dataUrl("image/png", PNG) } },
    { type: "file", file: { filename: "a.pdf", file_data: dataUrl("application/pdf", PDF) } },
    { type: "input_image", image_url: dataUrl("image/png", Buffer.concat([PNG, Buffer.from([1])])) },
  ], sdk);
  assert.deepEqual(found.map((a) => a.mime_type).sort(), ["application/pdf", "image/png", "image/png"]);
  assert.equal(Buffer.from(found.find((a) => a.filename === "a.pdf")!.content_base64!, "base64").toString(), PDF.toString());
});

test("LangChain standard blocks become attachments", () => {
  const { sdk } = client();
  const found = extractAttachments({ content: [
    { type: "image", source_type: "base64", data: PNG.toString("base64"), mime_type: "image/png" },
    { type: "file", source_type: "base64", data: PDF.toString("base64"), mime_type: "application/pdf", filename: "a.pdf" },
  ] }, sdk);
  assert.equal(found.length, 2);
});

test("the OpenAI wrapper sends the newest user message's files and the reasoning", async () => {
  const { sdk, transport } = client();
  const fake = { chat: { completions: { create: async () => ({ choices: [{ message: { content: "ok", reasoning_content: "thinking it over" } }] }) } } };
  const wrapped = instrumentOpenAI(fake as any, { sdkClient: sdk }) as any;
  await wrapped.chat.completions.create({ model: "m", messages: [{ role: "user", content: [
    { type: "text", text: "describe" }, { type: "image_url", image_url: { url: dataUrl("image/png", PNG) } }] }] });
  await sdk.flush();
  const sent = JSON.stringify(transport.requests);
  assert.match(sent, /image\/png/);
  assert.match(sent, /thinking it over/);
});

test("the LangChain handler waits for the scan and raises its errors", () => {
  const handler = langchainCallback({ sdkClient: client().sdk }) as any;
  assert.equal(handler.awaitHandlers, true);
  assert.equal(handler.raiseError, true);
});

test("reasoning is read from chat results and LangChain generations", () => {
  assert.equal(reasoningOf({ choices: [{ message: { reasoning_content: "a" } }] }).thinking, "a");
  assert.equal(reasoningOf({ generations: [[{ message: { additional_kwargs: { reasoning_content: "b" } } }]] }).thinking, "b");
  assert.deepEqual(reasoningOf({ choices: [{ message: { content: "x" } }] }), {});
});

test("Semantic Kernel filters hand the context on and scan the rendered prompt", async () => {
  const { semanticKernelFilters } = await import("../adapters/semantic-kernel.js");
  const { sdk, transport } = client();
  const filters = semanticKernelFilters({ sdkClient: sdk });
  const context: any = { prompt: "{{$input}}" };
  let received: unknown;
  await filters.promptRenderFilter(context, async (next) => {
    received = next;
    context.renderedPrompt = "rendered question";
  });
  assert.equal(received, context);
  assert.match(JSON.stringify(transport.requests), /rendered question/);
});

test("the LlamaIndex LLM wrapper scans chat calls, files included, and keeps the LLM usable", async () => {
  const { wrapLlamaIndexLLM } = await import("../adapters/llamaindex.js");
  const { sdk, transport } = client();
  class FakeLLM {
    #calls = 0;
    get calls() { return this.#calls; }
    async chat(params: any) { this.#calls += 1; return { message: { content: `echo ${params.messages.length}` } }; }
    metadata() { return { model: "fake", calls: this.#calls }; }
  }
  const llm = wrapLlamaIndexLLM(new FakeLLM(), { sdkClient: sdk }) as FakeLLM;
  const result = await llm.chat({ messages: [{ role: "user", content: [
    { type: "text", text: "describe" }, { type: "image_url", image_url: { url: dataUrl("image/png", PNG) } }] }] });
  assert.equal(result.message.content, "echo 1");
  assert.equal(llm.metadata().calls, 1); // private fields still work through the wrapper
  await sdk.flush();
  assert.match(JSON.stringify(transport.requests), /image\/png/);
});
