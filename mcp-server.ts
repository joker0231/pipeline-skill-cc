/**
 * MCP Server - Pipeline Skill for Claude Code
 * 
 * V4 Spec User 模式。
 * 
 * 职责：
 * 1. Bootstrap — 检查/安装 Alice 引擎、写入 LLM 配置、启动引擎和流水线服务
 * 2. 消息转发 — 将 CC 用户的自然语言需求转发给流水线服务（龙虾1）
 * 
 * 启动方式：npx tsx mcp-server.ts
 * 环境变量：
 *   PIPELINE_URL       — 流水线服务地址（默认 http://localhost:3000）
 *   PIPELINE_SERVICE_DIR — pipeline-service 项目目录（默认 ../pipeline-service）
 *   ALICE_BASE_DIR     — Alice 引擎数据目录（默认 ~/.alice-v2/data）
 *   ALICE_HTTP_PORT     — Alice 引擎端口（默认 8081）
 *   PIPELINE_PORT       — 流水线服务端口（默认 3000）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync, spawn } from "child_process";
import { existsSync, writeFileSync, mkdirSync, readFileSync, openSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { createServer as netCreateServer } from "net";
import { randomUUID } from "crypto";

// 每个 MCP server 进程（即每个 CC 窗口）生成唯一 session ID，确保不同窗口创建独立项目
const SESSION_ID = randomUUID().slice(0, 8);

// === 配置 ===

let ALICE_HTTP_PORT = process.env.ALICE_HTTP_PORT || "18081";
let PIPELINE_PORT = process.env.PIPELINE_PORT || "13000";
let PIPELINE_URL = process.env.PIPELINE_URL || `http://localhost:${PIPELINE_PORT}`;
let ALICE_ENGINE_URL = `http://localhost:${ALICE_HTTP_PORT}`;
const ALICE_INSTALL_SCRIPT = "http://8.149.243.230/release/latest/start.sh";
const ALICE_ENGINE_BIN = resolve(homedir(), ".alice-v2/alice-engine");
const REQUEST_TIMEOUT_MS = 180_000;

// 路径推算：cc-skill 和 pipeline-service 通常在同级目录
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const PIPELINE_SERVICE_DIR = process.env.PIPELINE_SERVICE_DIR || resolve(SCRIPT_DIR, "../pipeline-service");
const ALICE_BASE_DIR = process.env.ALICE_BASE_DIR || resolve(homedir(), ".alice-v2/data");
const WORKSPACE_DIR = resolve(PIPELINE_SERVICE_DIR, "../pipeline-workspace");
const GLOBAL_SETTINGS_PATH = resolve(ALICE_BASE_DIR, "global_settings.json");

// === 状态 ===

let bootstrapCompleted = false;

// === 工具函数 ===

function log(tag: string, msg: string): void {
  // MCP Server 通过 stdio 通信，日志写 stderr 避免干扰协议
  process.stderr.write(`[CC-SKILL][${tag}] ${msg}\n`);
}

/**
 * 检查命令是否存在
 */
function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取 Node.js 主版本号
 */
function getNodeMajorVersion(): number {
  try {
    const version = execFileSync("node", ["--version"], { encoding: "utf-8" }).trim();
    const match = version.match(/^v(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * 检查服务是否就绪
 */
async function isServiceReady(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 轮询等待服务就绪
 */
async function waitForService(name: string, url: string, maxWaitSecs: number): Promise<boolean> {
  const startTime = Date.now();
  const deadline = startTime + maxWaitSecs * 1000;

  while (Date.now() < deadline) {
    if (await isServiceReady(url)) {
      log("BOOTSTRAP", `${name} is ready at ${url}`);
      return true;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  log("BOOTSTRAP", `${name} did not become ready within ${maxWaitSecs}s`);
  return false;
}

/**
 * 后台启动进程
 */
function startBackground(command: string, args: string[], env: Record<string, string>, logFile: string): void {
  const out = openSync(logFile, "a");
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...env },
  });
  child.unref();
  log("BOOTSTRAP", `Started background process: ${command} ${args.join(" ")} (PID: ${child.pid})`);
}

/**
 * 检测端口是否可用，被占用则自动+1，直到找到可用端口
 */
async function findAvailablePort(startPort: number, maxAttempts: number = 20): Promise<number> {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = netCreateServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close();
        resolve(true);
      });
      server.listen(port, "127.0.0.1");
    });
    if (available) {
      if (port !== startPort) {
        log("BOOTSTRAP", `Port ${startPort} occupied, using ${port} instead`);
      }
      return port;
    }
  }
  throw new Error(`No available port found in range ${startPort}-${startPort + maxAttempts - 1}`);
}

// === 聊天功能 ===

interface ChatResult {
  reply: string;
  project_id?: string;
  preview_url?: string;
}

async function sendChatMessage(message: string, userId: string): Promise<ChatResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${PIPELINE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        content: message,
        channel: "cc",
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "无法读取错误详情");
      return { reply: `[MCP-ERROR] 流水线服务返回 ${res.status}: ${errorBody}` };
    }

    const data = (await res.json()) as { reply?: string; error?: string; project_id?: string; preview_url?: string };
    return {
      reply: data.reply || data.error || "流水线服务返回了空回复",
      project_id: data.project_id,
      preview_url: data.preview_url,
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { reply: `[MCP-ERROR] 请求超时（${REQUEST_TIMEOUT_MS / 1000}秒），流水线服务可能正忙` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { reply: `[MCP-ERROR] 无法连接流水线服务（${PIPELINE_URL}）: ${msg}` };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 通用 Pipeline API 调用
 */
async function callPipelineApi(method: string, path: string, body?: unknown): Promise<{ ok: boolean; data?: any; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const options: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(`${PIPELINE_URL}${path}`, options);

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "无法读取错误详情");
      return { ok: false, error: `HTTP ${res.status}: ${errorBody}` };
    }

    const data = await res.json();
    return { ok: true, data };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "请求超时（30秒）" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

// === Bootstrap 逻辑 ===

interface BootstrapResult {
  success: boolean;
  steps: string[];
  errors: string[];
}

async function runBootstrap(apiKey: string, model: string, deployPassword?: string, mode?: string): Promise<BootstrapResult> {
  const steps: string[] = [];
  const errors: string[] = [];
  const isProduction = mode !== "development";

  // Step 1: 检查前置依赖
  log("BOOTSTRAP", "Step 1: Checking prerequisites...");

  if (!commandExists("node")) {
    errors.push("❌ Node.js 未安装。请先安装 Node.js ≥18: https://nodejs.org/");
    return { success: false, steps, errors };
  }

  const nodeVersion = getNodeMajorVersion();
  if (nodeVersion < 18) {
    errors.push(`❌ Node.js 版本过低（v${nodeVersion}），需要 ≥18。请升级: https://nodejs.org/`);
    return { success: false, steps, errors };
  }
  steps.push(`✅ Node.js v${nodeVersion} (≥18)`);

  if (!commandExists("npm")) {
    errors.push("❌ npm 未安装");
    return { success: false, steps, errors };
  }
  steps.push("✅ npm 已安装");

  if (!commandExists("git")) {
    errors.push("❌ Git 未安装。请先安装: https://git-scm.com/");
    return { success: false, steps, errors };
  }
  steps.push("✅ Git 已安装");

  // Step 2: 检查/安装 Alice 引擎
  log("BOOTSTRAP", "Step 2: Checking Alice engine...");

  if (existsSync(ALICE_ENGINE_BIN)) {
    steps.push("✅ Alice 引擎已安装");
  } else {
    steps.push("⏳ 正在安装 Alice 引擎...");
    try {
      execFileSync("bash", ["-c", `curl -fsSL ${ALICE_INSTALL_SCRIPT} | bash`], {
        stdio: "pipe",
        timeout: 120_000,
      });
      if (existsSync(ALICE_ENGINE_BIN)) {
        steps.push("✅ Alice 引擎安装成功");
      } else {
        errors.push("❌ Alice 引擎安装脚本执行完毕但二进制未找到");
        return { success: false, steps, errors };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`❌ Alice 引擎安装失败: ${msg}`);
      return { success: false, steps, errors };
    }
  }

  // Step 3: 创建目录
  log("BOOTSTRAP", "Step 3: Creating directories...");

  if (!existsSync(ALICE_BASE_DIR)) {
    mkdirSync(ALICE_BASE_DIR, { recursive: true });
    steps.push(`✅ 创建 ALICE_BASE_DIR: ${ALICE_BASE_DIR}`);
  }

  if (!existsSync(WORKSPACE_DIR)) {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    steps.push(`✅ 创建 pipeline-workspace: ${WORKSPACE_DIR}`);
  }

  // Step 4: 写入 LLM 配置
  log("BOOTSTRAP", "Step 4: Writing global_settings.json...");

  const settings: Record<string, unknown> = {
    api_key: apiKey,
    model: model,
    session_blocks_limit: 4,
    session_block_kb: 2,
    history_kb: 2,
    safety_max_consecutive_beats: 20,
    safety_cooldown_secs: 30,
    temperature: 0.5,
    max_tokens: 16384,
    capture_max_tokens: 32768,
  };

  writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
  steps.push(`✅ LLM 配置已写入: ${GLOBAL_SETTINGS_PATH}`);

  // Step 5: 安装 pipeline-service 依赖
  log("BOOTSTRAP", "Step 5: Installing pipeline-service dependencies...");

  if (!existsSync(PIPELINE_SERVICE_DIR)) {
    errors.push(`❌ pipeline-service 目录不存在: ${PIPELINE_SERVICE_DIR}。请设置 PIPELINE_SERVICE_DIR 环境变量指向正确路径。`);
    return { success: false, steps, errors };
  }

  try {
    execFileSync("npm", ["install"], {
      cwd: PIPELINE_SERVICE_DIR,
      stdio: "pipe",
      timeout: 300_000,
    });
    steps.push("✅ pipeline-service npm install 完成");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`❌ npm install 失败: ${msg}`);
    return { success: false, steps, errors };
  }

  // Step 6: 编译 pipeline-service（生产模式）
  if (isProduction) {
    log("BOOTSTRAP", "Step 6: Building pipeline-service...");
    try {
      execFileSync("npm", ["run", "build"], {
        cwd: PIPELINE_SERVICE_DIR,
        stdio: "pipe",
        timeout: 120_000,
      });
      steps.push("✅ pipeline-service 编译完成");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`❌ 编译失败: ${msg}`);
      return { success: false, steps, errors };
    }
  } else {
    steps.push("⏭️ 开发模式，跳过编译");
  }

  // Step 7: 启动 Alice 引擎（如果未运行）
  log("BOOTSTRAP", "Step 7: Starting Alice engine...");

  const aliceReady = await isServiceReady(`${ALICE_ENGINE_URL}/api/instances`);
  if (aliceReady) {
    steps.push("✅ Alice 引擎已在运行");
  } else {
    // 自动寻找可用端口
    try {
      const actualAlicePort = await findAvailablePort(parseInt(ALICE_HTTP_PORT));
      ALICE_HTTP_PORT = String(actualAlicePort);
      ALICE_ENGINE_URL = `http://localhost:${ALICE_HTTP_PORT}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`❌ 无法找到可用端口（Alice引擎）: ${msg}`);
      return { success: false, steps, errors };
    }

    const aliceLogFile = "/tmp/alice-engine.log";
    startBackground(
      ALICE_ENGINE_BIN,
      [],
      {
        ALICE_HTTP_PORT: ALICE_HTTP_PORT,
        ALICE_BASE_DIR: ALICE_BASE_DIR,
      },
      aliceLogFile
    );

    const aliceUp = await waitForService("Alice 引擎", `${ALICE_ENGINE_URL}/api/instances`, 30);
    if (aliceUp) {
      steps.push("✅ Alice 引擎已启动");
    } else {
      errors.push(`❌ Alice 引擎启动超时（30秒）。查看日志: ${aliceLogFile}`);
      return { success: false, steps, errors };
    }
  }

  // Step 8: 安装 Playwright chromium（用于预览页面运行时检测）
  log("BOOTSTRAP", "Step 8: Installing Playwright chromium...");

  // 检查是否已安装（macOS 默认路径）
  const playwrightCacheDir = resolve(homedir(), "Library/Caches/ms-playwright");
  const chromiumInstalled = existsSync(playwrightCacheDir) &&
    readdirSync(playwrightCacheDir).some(f => f.startsWith("chromium-"));

  if (chromiumInstalled) {
    steps.push("✅ Playwright chromium 已安装（跳过）");
  } else {
    try {
      execFileSync("npx", ["playwright", "install", "chromium"], {
        cwd: PIPELINE_SERVICE_DIR,
        timeout: 180_000, // 3分钟超时
        stdio: "pipe",
      });
      steps.push("✅ Playwright chromium 已安装");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 非致命错误，继续执行
      steps.push(`⚠️ Playwright chromium 安装失败（非致命）: ${msg}`);
      log("BOOTSTRAP", `Playwright install failed (non-fatal): ${msg}`);
    }
  }

  // Step 9: 启动 pipeline-service（如果未运行）
  log("BOOTSTRAP", "Step 9: Starting pipeline-service...");

  const pipelineReady = await isServiceReady(`${PIPELINE_URL}/api/projects`);
  if (pipelineReady) {
    steps.push("✅ 流水线服务已在运行");
  } else {
    // 自动寻找可用端口
    try {
      const actualPipelinePort = await findAvailablePort(parseInt(PIPELINE_PORT));
      PIPELINE_PORT = String(actualPipelinePort);
      PIPELINE_URL = `http://localhost:${PIPELINE_PORT}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`❌ 无法找到可用端口（流水线服务）: ${msg}`);
      return { success: false, steps, errors };
    }

    const pipelineLogFile = "/tmp/pipeline-service.log";
    const pipelineEnv: Record<string, string> = {
      ALICE_ENGINE_URL: ALICE_ENGINE_URL,
      PIPELINE_HOST: PIPELINE_URL.replace(/:\d+$/, ''),  // 提取 host 部分
      PIPELINE_PORT: PIPELINE_PORT,
      PIPELINE_WORKSPACE: WORKSPACE_DIR,
    };

    if (deployPassword) {
      pipelineEnv.DEPLOY_PASSWORD = deployPassword;
    }

    if (isProduction) {
      startBackground(
        "node",
        [resolve(PIPELINE_SERVICE_DIR, "dist/index.js")],
        pipelineEnv,
        pipelineLogFile
      );
    } else {
      startBackground(
        "npx",
        ["tsx", resolve(PIPELINE_SERVICE_DIR, "src/index.ts")],
        pipelineEnv,
        pipelineLogFile
      );
    }

    const pipelineUp = await waitForService("流水线服务", `${PIPELINE_URL}/api/projects`, 30);
    if (pipelineUp) {
      steps.push("✅ 流水线服务已启动");
    } else {
      errors.push(`❌ 流水线服务启动超时（30秒）。查看日志: ${pipelineLogFile}`);
      return { success: false, steps, errors };
    }
  }

  return { success: true, steps, errors };
}

// === 初始化 MCP Server ===

const server = new McpServer({
  name: "pipeline-skill",
  version: "2.0.0",
  description: "AI 开发流水线工具集。当用户想要开发软件、构建应用、创建系统、写代码项目时，使用这些工具来驱动自动化开发流水线。",
});

// --- Bootstrap Tool ---

server.tool(
  "pipeline_bootstrap",
  `初始化 AI 开发流水线环境。

⚠️ 当用户想要开发软件、构建应用、创建系统、做项目时，必须先调用此工具启动流水线环境。
如果 pipeline_chat 返回"未就绪"，也需要先调用此工具。

需要用户提供：
- api_key：LLM API密钥（如 sk-xxx）
- model：模型标识（如 https://api.openai.com/v1/chat/completions@gpt-4）

执行步骤：
1. 检查前置依赖（Node.js ≥18、npm、Git）
2. 检查/安装 Alice 引擎
3. 写入 LLM 配置
4. 创建工作目录
5. 安装并编译流水线服务
6. 启动 Alice 引擎和流水线服务
7. 等待所有服务就绪

完成后使用 pipeline_chat 开始描述需求。`,
  {
    api_key: z.string().describe("LLM API Key（如 sk-xxx）"),
    model: z.string().describe("模型标识（如 zenmux@anthropic/claude-opus-4.6 或 https://api.example.com/v1/chat/completions@model-name）"),
    deploy_password: z.string().optional().describe("SSH 部署密码（可选，Phase 5 部署到云端时需要）"),
    mode: z.enum(["production", "development"]).optional().describe("运行模式（默认 production。development 跳过编译，用 tsx 直接运行）"),
  },
  async ({ api_key, model, deploy_password, mode }) => {
    log("BOOTSTRAP", "Bootstrap started");
    const result = await runBootstrap(api_key, model, deploy_password, mode);

    const lines: string[] = [];
    lines.push(result.success ? "# ✅ Bootstrap 完成" : "# ❌ Bootstrap 失败");
    lines.push("");
    lines.push("## 执行步骤");
    for (const step of result.steps) {
      lines.push(`- ${step}`);
    }
    if (result.errors.length > 0) {
      lines.push("");
      lines.push("## 错误");
      for (const err of result.errors) {
        lines.push(`- ${err}`);
      }
    }
    if (result.success) {
      lines.push("");
      lines.push("## 环境信息");
      lines.push(`- Alice 引擎: ${ALICE_ENGINE_URL}`);
      lines.push(`- 流水线服务: ${PIPELINE_URL}`);
      lines.push(`- 工作目录: ${WORKSPACE_DIR}`);
      lines.push(`- LLM 配置: ${GLOBAL_SETTINGS_PATH}`);
      lines.push("");
      lines.push(`📊 **监控面板**: ${PIPELINE_URL}/`);
      lines.push("在浏览器打开上述地址，可实时查看流水线运行状态。");
      lines.push("");
      lines.push("现在可以使用 `pipeline_chat` 与龙虾1对话，开始描述你的产品需求。");
      bootstrapCompleted = true;
    }

    log("BOOTSTRAP", `Bootstrap ${result.success ? "succeeded" : "failed"}`);
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// --- 状态检查 Tool ---

server.tool(
  "pipeline_status",
  `检查流水线状态。

- 不传 project_id：返回服务健康状态（Alice 引擎 + 流水线服务是否运行）
- 传 project_id：返回该项目的详细状态（阶段、进度、错误信息、部署URL等）`,
  {
    project_id: z.string().optional().describe("项目ID（可选）。传入则返回项目详情，不传则返回服务健康状态"),
  },
  async ({ project_id }) => {
    // 项目级状态查询
    if (project_id) {
      const result = await callPipelineApi("GET", `/api/projects/${project_id}`);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `❌ 查询失败: ${result.error}` }],
        };
      }

      const { project, agents, requirement } = result.data;
      const lines: string[] = [];
      lines.push(`# 项目状态: ${project_id}`);
      lines.push("");
      lines.push(`- **状态**: ${project.status}`);
      if (project.project_type === 'existing') {
        lines.push(`- **项目类型**: 已有项目（反向提取）`);
      }
      if (project.failed_at_stage) {
        lines.push(`- **失败阶段**: ${project.failed_at_stage}`);
      }
      if (project.error_summary) {
        lines.push(`- **错误摘要**: ${project.error_summary}`);
      }
      if (project.deploy_url) {
        lines.push(`- **部署URL**: ${project.deploy_url}`);
      }
      if (project.preview_url) {
        lines.push(`- **预览URL**: ${project.preview_url}`);
      }
      lines.push(`- **创建时间**: ${project.created_at}`);
      lines.push(`- **更新时间**: ${project.updated_at}`);

      if (agents && agents.length > 0) {
        lines.push("");
        lines.push("## Agent 实例");
        for (const agent of agents) {
          lines.push(`- ${agent.role}: ${agent.instance_id} (${agent.status})`);
        }
      }

      if (requirement) {
        lines.push("");
        lines.push("## 原始需求");
        lines.push(requirement);
      }

      // 提示可用操作
      lines.push("");
      lines.push("## 可用操作");
      if (project.status === "writing_preview" || project.status === "chatting") {
        lines.push("- 使用 `pipeline_chat` 继续对话，提出修改意见");
        if (project.preview_url) {
          lines.push(`- 预览地址: ${project.preview_url}`);
        }
      }
      if (project.status === "preview_ready") {
        lines.push("- 使用 `pipeline_confirm` 确认需求，推进到 Phase 2");
      }
      if (project.status === "spec_ready") {
        lines.push('- 反向提取完成！使用 `pipeline_chat` 提迭代需求（如"把idle检测频率从10改为5"）');
      }
      if (project.status === "importing" || project.status === "extracting_spec") {
        lines.push("- ⏳ 反向提取进行中，请稍候...");
      }
      if (project.status === "blocked" || project.status === "failed") {
        lines.push("- 使用 `pipeline_retry` 重试");
      }
      lines.push("- 使用 `pipeline_artifacts` 查看阶段产物");

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }

    // 服务级健康检查
    const aliceOk = await isServiceReady(`${ALICE_ENGINE_URL}/api/instances`);
    const pipelineOk = await isServiceReady(`${PIPELINE_URL}/api/projects`);

    const lines: string[] = [];
    lines.push("# 服务状态");
    lines.push(`- Alice 引擎 (${ALICE_ENGINE_URL}): ${aliceOk ? "✅ 运行中" : "❌ 未就绪"}`);
    lines.push(`- 流水线服务 (${PIPELINE_URL}): ${pipelineOk ? "✅ 运行中" : "❌ 未就绪"}`);

    if (!aliceOk || !pipelineOk) {
      lines.push("");
      lines.push("部分服务未就绪。请先调用 `pipeline_bootstrap` 初始化环境。");
    }

    // 列出所有项目
    if (pipelineOk) {
      const result = await callPipelineApi("GET", "/api/projects");
      if (result.ok && result.data?.projects?.length > 0) {
        lines.push("");
        lines.push("## 项目列表");
        for (const p of result.data.projects) {
          const statusIcon = p.status === "done" ? "✅" : p.status === "failed" ? "❌" : p.status === "blocked" ? "⏸️" : p.status === "spec_ready" ? "📋" : p.status === "importing" || p.status === "extracting_spec" ? "📦" : p.status === "writing_preview" ? "✏️" : p.status === "preview_ready" ? "🎨" : "🔄";
          lines.push(`- ${statusIcon} \`${p.id}\` — ${p.status}${p.failed_at_stage ? ` (失败于 ${p.failed_at_stage})` : ""}`);
        }
        lines.push("");
        lines.push("如需查看某个项目的详情，告诉我项目ID即可。");
      }
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// --- Chat Tool ---

server.tool(
  "pipeline_chat",
  `与 AI 开发流水线对话。当用户想要开发软件、构建应用、创建系统、写代码时，使用此工具。

使用场景：
- 用户说"做个xxx系统/应用/小程序" → 调用此工具
- 用户说"帮我开发/写/构建一个xxx" → 调用此工具
- 用户描述产品需求、功能需求 → 调用此工具
- 用户回答流水线的澄清问题 → 调用此工具

⚠️ 重要规则：
1. message 参数必须是用户的原话，禁止修改、整理、加工或替用户做需求分析
2. 不要自己分析需求后再发给流水线，流水线内部的龙虾1会自己引导用户澄清需求
3. 你的角色是消息搬运工，不是需求分析师
4. 错误示例："需求已经明确，请直接开始工作" ← 这是你编的，不是用户说的
5. 正确示例：用户说"帮我做一个请假审批系统" → message 就填"帮我做一个请假审批系统"

流水线会自动：对齐需求 → 生成需求原型 → 审核 → 写代码 → 测试 → 部署

⚠️ 首次使用前需先调用 pipeline_bootstrap 初始化环境。如果返回"未就绪"，请先调用 pipeline_bootstrap。

返回内容包含 project_id，后续可用 pipeline_status/pipeline_confirm/pipeline_retry 等工具。`,
  {
    message: z.string().describe("用户的消息内容（自然语言描述需求、回答问题、确认方案等）"),
    user_id: z.string().optional().describe("用户标识，用于保持对话上下文（可选，默认 cc-default-user）"),
  },
  async ({ message, user_id }) => {
    // 检查服务就绪状态
    if (!bootstrapCompleted) {
      const pipelineOk = await isServiceReady(`${PIPELINE_URL}/api/projects`);
      if (!pipelineOk) {
        return {
          content: [{
            type: "text" as const,
            text: "⚠️ 流水线服务未就绪。请先调用 `pipeline_bootstrap` 初始化环境。",
          }],
        };
      }
      bootstrapCompleted = true;
    }

    const result = await sendChatMessage(message, user_id || `cc-${SESSION_ID}`);

    const lines: string[] = [result.reply];
    if (result.project_id) {
      lines.push("");
      lines.push(`📋 项目ID: \`${result.project_id}\``);

      // 获取项目状态，智能提示
      try {
        const projRes = await callPipelineApi("GET", `/api/projects/${result.project_id}`);
        const project = projRes.data?.project as { status?: string; deploy_url?: string; error_summary?: string; failed_at_stage?: string } | undefined;
        if (project) {
          if (project.status === "writing_preview") {
            lines.push("");
            lines.push(`✏️ **正在编写预览中...**`);
            if (result.preview_url) {
              lines.push(`可以在 ${result.preview_url} 查看当前效果。`);
            }
            lines.push(`继续和龙虾1对话，提出修改意见。确认需求后告诉我"可以了"。`);
          }
          if (project.status === "preview_ready") {
            lines.push("");
            lines.push(`🎨 **需求原型已就绪！** 请在 ${PIPELINE_URL}/preview/${result.project_id}/ 查看预览。`);
            lines.push(`确认无误后，使用 \`pipeline_confirm\` 或告诉我"确认需求"推进到下一阶段。`);
          }
          if (project.status === "spec_ready") {
            lines.push("");
            lines.push(`📋 **Spec User 已就绪！** 反向提取完成，已生成分模块的结构化描述。`);
            lines.push(`现在可以直接描述你的迭代需求（如"把idle检测频率从10改为5"），流水线会定位相关模块并开始开发。`);
          }
          if (project.status === "done" && project.deploy_url) {
            lines.push("");
            lines.push(`🎉 **已部署上线！** 访问: ${project.deploy_url}`);
          } else if (project.status === "done") {
            lines.push("");
            lines.push(`✅ **流水线已完成！**`);
          }
          if (project.status === "blocked") {
            lines.push("");
            lines.push(`⏸️ **流水线遇到瓶颈**，阶段: ${project.failed_at_stage || "未知"}。${project.error_summary ? `原因: ${project.error_summary}` : ""}`);
            lines.push(`使用 \`pipeline_retry\` 或告诉我"重试"来恢复流水线。`);
          }
          if (project.status === "failed") {
            lines.push("");
            lines.push(`❌ **流水线失败**，阶段: ${project.failed_at_stage || "未知"}。${project.error_summary ? `原因: ${project.error_summary}` : ""}`);
            lines.push(`使用 \`pipeline_retry\` 或告诉我"重试"来重新启动。`);
          }
        }
      } catch {
        // 获取状态失败不影响主流程
      }
    }
    if (result.preview_url) {
      lines.push(`🔗 预览: ${result.preview_url}`);
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// --- Confirm Tool ---

server.tool(
  "pipeline_confirm",
  `确认项目需求，推进流水线从 Phase 1（对齐）进入 Phase 2（需求守卫）。

当项目状态为 preview_ready 时调用此工具确认需求。确认后龙虾2将开始审核 Spec User、补充边界case、发散测试用例。`,
  {
    project_id: z.string().describe("项目ID"),
  },
  async ({ project_id }) => {
    const result = await callPipelineApi("POST", `/api/projects/${project_id}/confirm`, { confirmed: true });

    if (!result.ok) {
      return {
        content: [{ type: "text" as const, text: `❌ 确认失败: ${result.error}` }],
      };
    }

    const lines: string[] = [];
    lines.push("✅ 需求已确认，流水线推进到 Phase 2（需求守卫）");
    lines.push("");
    lines.push("龙虾2 正在：");
    lines.push("1. 审核 Spec User（7个维度检查）");
    lines.push("2. 补充边界case");
    lines.push("3. 发散测试用例");
    lines.push("4. 蓝红攻防验证");
    lines.push("");
    lines.push("流水线正在自动运行中，完成后会通知你。");

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// --- Artifacts Tool ---

server.tool(
  "pipeline_artifacts",
  `查看项目各阶段的产物文件列表。

返回 align（对齐）、guard（守卫）、adversarial（攻防）、coding（编码）、review（测试）各阶段生成的文件。`,
  {
    project_id: z.string().describe("项目ID"),
    file_path: z.string().optional().describe("文件路径（可选）。传入则读取该文件内容，不传则返回文件列表"),
  },
  async ({ project_id, file_path }) => {
    // 读取具体文件
    if (file_path) {
      const result = await callPipelineApi("GET", `/api/projects/${project_id}/files?path=${encodeURIComponent(file_path)}`);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `❌ 读取失败: ${result.error}` }],
        };
      }

      const lines: string[] = [];
      lines.push(`# 📄 ${file_path}`);
      lines.push("");
      lines.push("```");
      lines.push(result.data.content || "(空文件)");
      if (result.data.truncated) {
        lines.push("\n... (文件过大，已截断)");
      }
      lines.push("```");

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }

    // 文件列表
    const result = await callPipelineApi("GET", `/api/projects/${project_id}/artifacts`);
    if (!result.ok) {
      return {
        content: [{ type: "text" as const, text: `❌ 查询失败: ${result.error}` }],
      };
    }

    const lines: string[] = [];
    lines.push(`# 📦 项目产物: ${project_id}`);

    const stageNames: Record<string, string> = {
      align: "Phase 1 对齐",
      guard: "Phase 2 守卫",
      adversarial: "攻防记录",
      coding: "Phase 3 编码",
      review: "Phase 4 测试",
    };

    let totalFiles = 0;
    for (const [stage, label] of Object.entries(stageNames)) {
      const files = result.data[stage];
      if (files && files.length > 0) {
        lines.push("");
        lines.push(`## ${label}`);
        for (const f of files) {
          const sizeKB = (f.size / 1024).toFixed(1);
          lines.push(`- \`${f.path}\` (${sizeKB} KB)`);
          totalFiles++;
        }
      }
    }

    if (totalFiles === 0) {
      lines.push("");
      lines.push("暂无产物文件。");
    } else {
      lines.push("");
      lines.push(`共 ${totalFiles} 个文件。使用 \`pipeline_artifacts\` 传入 file_path 查看文件内容。`);
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// --- Retry Tool ---

server.tool(
  "pipeline_retry",
  `重试失败或阻塞的项目。

当项目状态为 failed 或 blocked 时调用此工具重新启动流水线。可选指定从哪个阶段开始重试。`,
  {
    project_id: z.string().describe("项目ID"),
    target_stage: z.string().optional().describe("目标阶段（可选，如 extracting_schema、guard_reviewing、coding、code_review）"),
  },
  async ({ project_id, target_stage }) => {
    const body: Record<string, string> = {};
    if (target_stage) {
      body.target_stage = target_stage;
    }

    const result = await callPipelineApi("POST", `/api/projects/${project_id}/retry`, Object.keys(body).length > 0 ? body : undefined);

    if (!result.ok) {
      return {
        content: [{ type: "text" as const, text: `❌ 重试失败: ${result.error}` }],
      };
    }

    const lines: string[] = [];
    lines.push("✅ 重试已启动");
    if (target_stage) {
      lines.push(`从阶段 \`${target_stage}\` 开始重试。`);
    }
    lines.push("");
    lines.push("流水线正在自动运行中，完成后会通知你。");

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// === pipeline_import ===

server.tool(
  "pipeline_import",
  `导入已有代码项目到流水线。当用户说"我有一个现有项目/已有代码要迭代"时使用此工具。

使用场景：
- 用户想在已有项目上迭代开发
- 用户想让流水线帮忙维护/改进现有代码
- 用户提供了代码仓库路径

流程：
1. 拷贝代码到工作空间
2. AST 静态分析，自动识别模块结构
3. LLM 生成每个模块的结构化描述（Spec User）
4. 生成测试映射

完成后（状态变为 spec_ready），用户可以用 pipeline_chat 描述迭代需求，流水线会自动定位相关模块并开发。`,
  {
    project_name: z.string().describe("项目名称"),
    source_path: z.string().describe("代码路径（绝对路径，如 /Users/xxx/project）"),
    description: z.string().optional().describe("项目描述（可选）"),
  },
  async ({ project_name, source_path, description }) => {
    if (!bootstrapCompleted) {
      return {
        content: [{ type: "text" as const, text: "⚠️ 流水线服务未就绪。请先调用 `pipeline_bootstrap` 初始化环境。" }],
      };
    }

    const result = await callPipelineApi("POST", "/api/projects/import", {
      project_name,
      source_path,
      description: description || `Imported project: ${project_name}`,
    });

    if (!result.ok) {
      return {
        content: [{ type: "text" as const, text: `❌ 导入失败: ${result.error}` }],
      };
    }

    const data = result.data;
    const lines: string[] = [];
    lines.push(`✅ 项目导入已启动`);
    lines.push("");
    lines.push(`- **项目ID**: \`${data.project_id}\``);
    lines.push(`- **状态**: ${data.status}`);
    lines.push(`- **来源**: ${source_path}`);
    lines.push("");
    lines.push("正在进行反向提取（Phase 0）：分析代码结构、识别模块、生成 Spec User...");
    lines.push("这个过程可能需要几分钟，取决于项目大小。");
    lines.push("");
    lines.push("反向提取完成后会自动通知你。");
    lines.push(`提取完成后（状态变为 spec_ready），使用 \`pipeline_chat\` 提迭代需求。`);

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// === 启动 ===

const transport = new StdioServerTransport();
await server.connect(transport);