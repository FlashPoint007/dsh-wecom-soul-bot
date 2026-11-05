# dsh-wecom-soul-bot

DeepSeek Harness 插件：把企业微信智能机器人通过官方长连接（Bot ID + Secret，无需公网回调）接入 DSH，并给它加上人设、发送者身份、三层长期记忆、提醒和主动消息。私聊直接对话，群里 @ 它回复。

## 功能

- **长连接接入**：使用官方 `@wecom/aibot-node-sdk` WebSocket 长连接；用户分组、授权、会话管理、工具审批在插件页完成。
- **人设**：只注入机器人绑定的会话，DSH 里的其他会话不受影响。默认人设「大肥鱼」，插件页可改。
- **发送者身份**：每条消息前由插件写入 `【对话环境】` 行（私聊/群聊、发送者 userid、是否主人）；消息里伪造的同名标签会被替换。
- **三层记忆**：工作记忆即会话上下文；核心记忆不衰减、每轮注入，只有主人能写；情景记忆按遗忘曲线衰减（半衰期可调，重要度和每次回忆都会延长），按话题与清晰度挑选注入，淡忘后仍可用 `wecom_memory_recall` 找回。共享记忆只能在主人私聊时写入，疑似密钥的内容一律拒绝。
- **工作模式**（默认关闭）：只有整轮消息都来自主人时才放行 skill 与工具，由 DSH `tools.guard` 在工具层拦截；工作规则要求先加载 skill、先出计划、确认后执行、执行后回读验证。
- **提醒**：`wecom_reminder_set/list/cancel`，到点用人设口吻发回原会话；插件停机期间到期的提醒在恢复后补发，超过 12 小时作废。
- **主动搭话**（默认关闭）：本地掷骰决定，只发主人私聊，带安静时段、每日上限、冷却；模型回复 `[SKIP]` 时不发送。
- **运行中自动插话**（默认关闭）：任务运行时主人的纯文字并入当前回合（等同 `/steer`），其他消息照常排队。
- **命令**：`/stop` `/steer` `/clear` `/model` `/history`，以及 `/new` `/sessions` `/use` `/compact` `/delete` `/approve` 等。
- **可靠投递**：发送明确失败时最多重试 3 次，结果不确定时不重试；聊天模式下插件停机期间完成的回复在重启后补发一次。
- **图片输入**：图片与图文混排消息交给模型（最多 4 张，每张 ≤ 5 MiB）。
- **宿主服务**：`ctx.provide('wecomSoulBot')` 提供 `send`（仅限已授权会话）、`listTargets`、`describeConversation`；会话绑定变化时发出 `wecom-soul-bot/session-unbind` 与 `wecom-soul-bot/session-bind` 事件。

## 安装

```sh
dsh plugin --profile desktop add https://github.com/FlashPoint007/dsh-wecom-soul-bot/releases/latest/download/dsh-wecom-soul-bot.tgz
```

`--profile` 按你使用的 profile 填写（桌面版一般是 `desktop`，网页版是 `web`）。装完重启 DSH。

从源码安装：`git clone` 后执行 `pnpm install && pnpm run build`，再 `dsh plugin --profile desktop add <仓库绝对路径>`。仓库不提交 `dist/`，必须先构建。

## 使用

1. **连接**：插件页「连接」填写企业微信管理后台 → 智能机器人 → API 模式里的 Bot ID 和 Secret。Secret 存进 DSH 凭据库（`WECOM_SOUL_BOT_SECRET`），不写配置文件。
2. **授权**：给机器人发一条消息（群里 @ 它），对方会出现在「待授权」里，把它加入分组。
3. **人设与记忆**：插件页「人设与记忆」里填写主人 userid（留空沿用管理员列表；注意企业微信下发的可能是加密 userid，以插件日志里的发送者 id 为准），按需开启工作模式、提醒、主动搭话、自动插话。

## 安全提示

- 群聊每条消息都会驱动你本机的 DSH Agent。群聊分组请保持「仅可查看」权限；工具审批只推送给管理员私聊。
- 人设和工作规则是提示词，不是隔离；真正的边界是工作区权限、DSH 审批和工作模式的工具拦截。

## 开发

```sh
pnpm install
pnpm run verify   # build + typecheck + 全部测试
```

## 许可

MIT，见 [LICENSE](LICENSE)。
