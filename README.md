# pipeline-skill-cc

Claude Code 入口层 — AI 开发流水线的 MCP Server Skill。

纯消息转发层，将 CC 用户的自然语言需求通过 `pipeline_chat` tool 转发给流水线服务（龙虾1），零业务逻辑。

## 使用

```bash
npm install
npm start
```

环境变量 `PIPELINE_URL` 可指定流水线服务地址（默认 `http://localhost:13000`）。

## Claude Code 配置

在 `~/.claude/settings.json` 中添加：

```json
{
  "mcpServers": {
    "pipeline": {
      "command": "npx",
      "args": ["tsx", "/Users/joker/Desktop/pipeline-skill-cc/mcp-server.ts"],
      "env": { "PIPELINE_URL": "http://localhost:13000" }
    }
  }
}
```