# dsh-wecom-soul-bot

企业微信智能机器人（长连接）＋ 人设 ＋ 长期记忆，一个 DeepSeek Harness 插件搞定。群里 @ 它，它用人设的口吻直接回话。

基于两个 MIT 插件合并改造：

| 来源 | 提供的能力 |
| --- | --- |
| [lastorder/dsh-wecom-bot](https://github.com/lastorder/dsh-wecom-bot) 1.1.0 | 官方 `@wecom/aibot-node-sdk` 长连接、用户分组、授权、会话管理、审批 |
| [Scorp1o117/dsh-soul-md](https://github.com/Scorp1o117/dsh-soul-md) 0.11.0 | 人设卡注入 system prompt、记忆注入与记忆工具的思路 |

## 新增了什么

- **人设**：只注入机器人自己绑定的会话。你在 DSH 里开的其他会话不受影响。默认人设是「大肥鱼」，改编自数字生命卡兹克的养鱼教程，去掉了企微做不到的 QQ 空间、签名和表情包。
- **发送者身份**：插件在每条消息前写一行 `【对话环境】`，注明私聊或群聊、发送者 userid、是不是主人。消息正文里伪造的同名标签会被替换，所以别人在群里自称主人没有用。
- **长期记忆**：每个私聊或群各有一份会话记忆，另有一份所有会话都能读到的共享记忆。共享记忆只能在主人私聊时写入，避免群友往里塞东西。像密码、密钥、卡号的内容一律不记。
- **聊天模式**（默认开）：只回模型原话，不发「已提交给 DSH」回执和会话卡片。群聊回复只发回这个群，不抄送给管理员。

记忆以 Markdown 存放在 `<DSH home>/wecom-soul-bot/soul/memory/`，模型通过 `wecom_memory_remember` / `wecom_memory_forget` 两个工具读写。这两个工具只在机器人绑定的会话里可用。

刻意没有移植 soul-md 的 `soul_update`（让 AI 改写自己的人设）：群里任何人都能 @ 机器人，这个工具会被利用来篡改人设。人设只能在插件页修改。

## 快速开始

1. 安装：`git clone https://github.com/FlashPoint007/dsh-wecom-soul-bot && cd dsh-wecom-soul-bot && pnpm install && pnpm run build`，再执行 `dsh plugin --profile desktop add <克隆目录的绝对路径>`，然后重启 DSH。仓库不提交 `dist/`，所以必须先构建。
2. 连接：打开插件页「连接」，填企业微信管理后台 → 智能机器人 → API 模式里的 **Bot ID** 和 **Secret**。Secret 存进 DSH 凭据库（`WECOM_SOUL_BOT_SECRET`），不写配置文件。
3. 授权：把机器人拉进群，在群里 @ 它一次，群会出现在「待授权」里，把它加入分组。默认分组的工作区权限是「仅可查看」，**不要**为群聊放开写权限。
4. 设置人设：插件页「人设与记忆」里填主人 userid（留空则沿用管理员列表），按需修改人设提示词。
5. 在群里 @ 它说句话。

## 安全提示

- 群聊里的每条消息都会驱动你本机的 DSH Agent。务必给群聊分组选「仅可查看」权限，工具审批只会发给管理员私聊。
- 人设和规则只是提示词，不是硬隔离。真正的边界是工作区权限和审批。

## 开发

```sh
pnpm install
pnpm run verify   # build + typecheck + 全部测试
```

新增代码在 `src/host/soul/`（存储、prompt 注入、记忆工具）和 `src/client/components/SoulSection.tsx`（设置页分区）。bridge 只加了两个挂钩：提交前标注发送者，聊天模式下直接回原话。上游原有功能与命令（`/help`、`/new`、`/sessions` 等）保持不变，详见上游 README。

## 许可

MIT，保留两个上游作者的署名，见 [LICENSE](LICENSE)。
